//! Post-commit notifier with a stable multi-observer seam.
//!
//! `Database::write` builds a [`CommitEvent`] from the committed
//! transaction's touched documents and dispatches it to every
//! registered [`CommitObserver`] on the commit-`Ok` path only
//! (rollback/panic never dispatch). The reactive `live()` subsystem
//! (`crate::live`) is itself just one registered observer; an external
//! package (e.g. a future Pro `DevTools` subscription debugger) attaches
//! as an additional observer through [`Notifier::add_observer`] WITHOUT
//! modifying this crate — the M3 extension seam
use std::collections::BTreeSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

/// What happened to one document in a committed transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeOp {
    Insert,
    Delete,
    // NOTE(M3 spec §8): `Update` is a documented future extension point;
    // M2 has no update path, so it is intentionally absent in M3.
}

/// One committed document change. `doc_id` is the raw key bytes (the
/// notifier sits at the M1 bytes boundary); M3 reactive correctness
/// uses only [`CommitEvent::touched_collections`].
#[derive(Debug, Clone)]
pub struct DocChange {
    pub collection: String,
    pub op: ChangeOp,
    pub doc_id: Vec<u8>,
}

/// The structured payload dispatched after a successful commit.
#[derive(Debug, Clone)]
pub struct CommitEvent {
    pub changes: Vec<DocChange>,
}

impl CommitEvent {
    #[must_use]
    pub const fn new(changes: Vec<DocChange>) -> Self {
        Self { changes }
    }

    /// The distinct collections touched by this commit, sorted.
    #[must_use]
    pub fn touched_collections(&self) -> BTreeSet<&str> {
        self.changes.iter().map(|c| c.collection.as_str()).collect()
    }
}

/// A passive or active observer of committed changes.
///
/// Implementations MUST be cheap and non-blocking (dispatch is
/// synchronous on the committing thread) and MUST NOT rely on being
/// the only observer or on a particular position beyond registration
/// order.
pub trait CommitObserver: Send + Sync {
    fn on_commit(&self, ev: &CommitEvent);
}

type Slot = (u64, Weak<dyn CommitObserver>);

struct Inner {
    // No user/observer code runs while this lock is held (`dispatch`
    // collects upgraded `Arc`s then drops the guard before calling
    // `on_commit`); every critical section here (push / collect /
    // retain) is panic-free. The mutex is therefore effectively
    // unpoisonable, so the `Ok`-guarded lock sites silently treat a
    // (theoretically impossible) poisoned lock as a no-op rather than
    // panicking.
    slots: Mutex<Vec<Slot>>,
    next_id: AtomicU64,
}

/// Ordered, panic-isolated registry of [`CommitObserver`]s.
#[derive(Clone)]
pub struct Notifier {
    inner: Arc<Inner>,
}

impl Notifier {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                slots: Mutex::new(Vec::new()),
                next_id: AtomicU64::new(0),
            }),
        }
    }

    /// Registers `obs`. The returned [`ObserverHandle`] owns the strong
    /// `Arc` and unregisters on drop (RAII); the registry holds only a
    /// `Weak`, so the handle's lifetime alone controls delivery and no
    /// `Notifier → observer → … → Notifier` strong cycle can form.
    pub fn add_observer(&self, obs: Arc<dyn CommitObserver>) -> ObserverHandle {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut slots) = self.inner.slots.lock() {
            slots.push((id, Arc::downgrade(&obs)));
        }
        ObserverHandle {
            inner: Arc::downgrade(&self.inner),
            id,
            _strong: obs,
        }
    }

    /// Dispatches `ev` to every live observer in registration order.
    /// Each `on_commit` is `catch_unwind`-isolated: a panicking
    /// observer poisons neither the caller (the committing thread) nor
    /// any other observer.
    pub fn dispatch(&self, ev: &CommitEvent) {
        let observers: Vec<Arc<dyn CommitObserver>> = {
            let Ok(slots) = self.inner.slots.lock() else {
                return;
            };
            slots.iter().filter_map(|(_, w)| w.upgrade()).collect()
        };
        for obs in observers {
            let _ = catch_unwind(AssertUnwindSafe(|| obs.on_commit(ev)));
        }
    }
}

impl Default for Notifier {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII registration handle. Dropping it unregisters the observer.
pub struct ObserverHandle {
    inner: Weak<Inner>,
    id: u64,
    _strong: Arc<dyn CommitObserver>,
}

impl Drop for ObserverHandle {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            if let Ok(mut slots) = inner.slots.lock() {
                slots.retain(|(sid, _)| *sid != self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct Counter(AtomicUsize);
    impl CommitObserver for Counter {
        fn on_commit(&self, ev: &CommitEvent) {
            self.0.fetch_add(ev.changes.len().max(1), Ordering::SeqCst);
        }
    }

    struct OrderRec(Arc<std::sync::Mutex<Vec<u8>>>, u8);
    impl CommitObserver for OrderRec {
        fn on_commit(&self, _ev: &CommitEvent) {
            self.0.lock().unwrap().push(self.1);
        }
    }

    struct Panicker;
    impl CommitObserver for Panicker {
        fn on_commit(&self, _ev: &CommitEvent) {
            panic!("observer must not poison dispatch");
        }
    }

    fn ev() -> CommitEvent {
        CommitEvent::new(vec![DocChange {
            collection: "users".into(),
            op: ChangeOp::Insert,
            doc_id: b"u1".to_vec(),
        }])
    }

    #[test]
    fn dispatch_invokes_registered_observers_in_registration_order() {
        let n = Notifier::new();
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let _h1 = n.add_observer(Arc::new(OrderRec(log.clone(), 1)));
        let _h2 = n.add_observer(Arc::new(OrderRec(log.clone(), 2)));
        n.dispatch(&ev());
        assert_eq!(*log.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn observer_handle_drop_unregisters() {
        let n = Notifier::new();
        let c = Arc::new(Counter(AtomicUsize::new(0)));
        let h = n.add_observer(c.clone());
        n.dispatch(&ev());
        drop(h);
        n.dispatch(&ev());
        assert_eq!(
            c.0.load(Ordering::SeqCst),
            1,
            "no delivery after handle drop"
        );
    }

    #[test]
    fn a_panicking_observer_does_not_poison_others_or_the_caller() {
        let n = Notifier::new();
        let _p = n.add_observer(Arc::new(Panicker));
        let c = Arc::new(Counter(AtomicUsize::new(0)));
        let _h = n.add_observer(c.clone());
        n.dispatch(&ev()); // must not unwind
        assert_eq!(c.0.load(Ordering::SeqCst), 1, "later observer still ran");
    }

    #[test]
    fn touched_collections_dedupes_and_collects() {
        let e = CommitEvent::new(vec![
            DocChange {
                collection: "a".into(),
                op: ChangeOp::Insert,
                doc_id: b"1".to_vec(),
            },
            DocChange {
                collection: "a".into(),
                op: ChangeOp::Delete,
                doc_id: b"2".to_vec(),
            },
            DocChange {
                collection: "b".into(),
                op: ChangeOp::Insert,
                doc_id: b"3".to_vec(),
            },
        ]);
        let cols: Vec<&str> = e.touched_collections().into_iter().collect();
        assert_eq!(cols, vec!["a", "b"]); // BTreeSet → sorted, deduped
    }
}
