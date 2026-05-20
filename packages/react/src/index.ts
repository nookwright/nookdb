import { useEffect, useRef, useState, type DependencyList } from 'react';
import type { LiveQuery, NookError } from 'nookdb';

/**
 * Subscribes to a `LiveQuery` for the component's lifetime. Returns the
 * latest snapshot (PRD §7.3). The query is created from `factory` once
 * per `deps` change and disposed on unmount / before recreation. A
 * recompute error is rethrown during render so a React error boundary
 * can catch it (M3-minimal — no built-in error UI).
 */
export function useLive<T>(factory: () => LiveQuery<T>, deps: DependencyList = []): T[] {
  const [snapshot, setSnapshot] = useState<T[]>(() => []);
  const errorRef = useRef<unknown>(undefined);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const lq = factory();
    setSnapshot(lq.value);
    const off = lq.subscribe(
      (v: T[]) => setSnapshot(v),
      (e: NookError) => {
        errorRef.current = e;
        forceRender((n) => n + 1);
      },
    );
    return () => {
      off();
      lq.dispose();
    };
  }, deps);

  if (errorRef.current !== undefined) throw errorRef.current;
  return snapshot;
}
