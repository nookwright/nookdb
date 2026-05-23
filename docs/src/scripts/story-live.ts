// Drives the "query that re-renders itself" demo in StoryCardLive.
//
// A live query `db.todos.where(t => !t.done).live()` is subscribed once.
// Mutations re-render the result panel without a refetch. The demo plays a
// short scripted teaser when it scrolls into view, then hands the controls to
// the visitor: insert / complete / reset buttons let *them* drive the query
// and watch it react. The first click stops the teaser.
//
// Fully degrades under prefers-reduced-motion: no pulse, no row animation,
// instant applies — but the buttons still work.

interface Todo {
  id: string;
  title: string;
}

interface Mutation {
  code: string;
  apply: (rows: Todo[]) => Todo[];
  touches: string | null;
  kind: 'insert' | 'update';
}

const BASE: Todo[] = [
  { id: 'a', title: 'buy milk' },
  { id: 'b', title: 'ship nookdb' },
];

// Scripted teaser: insert, complete (leaves the !done view), insert, complete.
const SCENARIO: Mutation[] = [
  {
    kind: 'insert',
    code: "db.todos.insert({ title: 'walk the dog' })",
    touches: 'c',
    apply: (r) => [...r, { id: 'c', title: 'walk the dog' }],
  },
  {
    kind: 'update',
    code: "db.todos.update({ id: 'a' }, { done: true })",
    touches: 'a',
    apply: (r) => r.filter((t) => t.id !== 'a'),
  },
  {
    kind: 'insert',
    code: "db.todos.insert({ title: 'water plants' })",
    touches: 'd',
    apply: (r) => [...r, { id: 'd', title: 'water plants' }],
  },
  {
    kind: 'update',
    code: "db.todos.update({ id: 'b' }, { done: true })",
    touches: 'b',
    apply: (r) => r.filter((t) => t.id !== 'b'),
  },
];

// Titles cycled through by the interactive "insert todo" button.
const INSERT_TITLES = [
  'call mom',
  'read the docs',
  'fix the bug',
  'water plants',
  'walk the dog',
  'pay rent',
];

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, reduced ? 0 : ms));

function rowEl(t: Todo): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'sl__row';
  li.dataset.id = t.id;
  li.innerHTML =
    `<span class="sl__check" aria-hidden="true"></span>` +
    `<span class="sl__row-title">${t.title}</span>`;
  return li;
}

function renderStatic(list: HTMLElement, rows: Todo[]) {
  list.replaceChildren(...rows.map(rowEl));
}

interface Controller {
  fire: (m: Mutation) => Promise<void>;
  reset: () => void;
  insertOne: () => void;
  completeTop: () => void;
  interacted: boolean;
}

function makeController(root: HTMLElement): Controller | null {
  const listQ = root.querySelector<HTMLElement>('[data-sl-list]');
  const pulseQ = root.querySelector<HTMLElement>('[data-sl-pulse]');
  const eventCodeQ = root.querySelector<HTMLElement>('[data-sl-eventcode]');
  const eventChipQ = root.querySelector<HTMLElement>('[data-sl-event]');
  const subLine = root.querySelector<HTMLElement>('.sl__sub');
  const counterQ = root.querySelector<HTMLElement>('[data-sl-count]');
  if (!listQ || !pulseQ || !eventCodeQ || !eventChipQ || !counterQ) return null;

  // Bind the narrowed (non-null) values to fresh consts so the nested closures
  // below keep the non-null type — TS does not propagate the guard into them.
  const list = listQ;
  const pulse = pulseQ;
  const eventCode = eventCodeQ;
  const eventChip = eventChipQ;
  const counter = counterQ;

  let rows = [...BASE];
  let count = 0;
  let busy = false;
  let insertIdx = 0;
  let uid = 0;

  renderStatic(list, rows);

  async function fire(m: Mutation) {
    if (busy) return;
    busy = true;

    // 1. surface the mutation on the source chip
    eventCode.textContent = m.code;
    eventChip.classList.add('is-firing');
    await wait(380);

    // 2. send a pulse down the wire (skipped under reduced motion)
    if (!reduced) {
      pulse.classList.remove('is-traveling');
      void pulse.offsetWidth; // force reflow so the animation restarts
      pulse.classList.add('is-traveling');
      await wait(620);
    }

    // 3. pulse arrives — the subscription's callback fires, list re-renders
    subLine?.classList.add('is-fired');
    const next = m.apply(rows);

    if (m.kind === 'insert') {
      const added = next.find((t) => !rows.some((r) => r.id === t.id));
      rows = next;
      if (added) {
        const el = rowEl(added);
        if (!reduced) el.classList.add('sl__row--enter');
        list.appendChild(el);
        if (!reduced) {
          requestAnimationFrame(() => el.classList.remove('sl__row--enter'));
        }
      }
    } else {
      // update done:true → strike, then collapse out of the filtered view
      const leaving = list.querySelector<HTMLElement>(
        `[data-id="${m.touches}"]`,
      );
      if (leaving) {
        leaving.classList.add('sl__row--done');
        await wait(560);
        leaving.classList.add('sl__row--exit');
        await wait(360);
        leaving.remove();
      }
      rows = next;
    }

    count += 1;
    counter.textContent = String(count);

    await wait(340);
    eventChip.classList.remove('is-firing');
    subLine?.classList.remove('is-fired');
    busy = false;
  }

  const ctrl: Controller = {
    fire,
    interacted: false,
    reset() {
      if (busy) return;
      rows = [...BASE];
      renderStatic(list, rows);
    },
    insertOne() {
      const title = INSERT_TITLES[insertIdx % INSERT_TITLES.length] ?? 'todo';
      insertIdx += 1;
      uid += 1;
      const id = `u${uid}`;
      void fire({
        kind: 'insert',
        code: `db.todos.insert({ title: '${title}' })`,
        touches: id,
        apply: (r) => [...r, { id, title }],
      });
    },
    completeTop() {
      const top = rows[0];
      if (!top) return;
      const id = top.id;
      void fire({
        kind: 'update',
        code: `db.todos.update({ id: '${id}' }, { done: true })`,
        touches: id,
        apply: (r) => r.filter((t) => t.id !== id),
      });
    },
  };

  return ctrl;
}

async function teaser(ctrl: Controller) {
  for (const m of SCENARIO) {
    if (ctrl.interacted) return;
    await ctrl.fire(m);
    if (ctrl.interacted) return;
    await wait(900);
  }
}

function wireControls(root: HTMLElement, ctrl: Controller) {
  const buttons = root.querySelectorAll<HTMLButtonElement>('[data-sl-action]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      ctrl.interacted = true;
      root.classList.add('is-driven'); // reveal "you're driving it" affordance
      const action = btn.dataset.slAction;
      if (action === 'insert') ctrl.insertOne();
      else if (action === 'complete') ctrl.completeTop();
      else if (action === 'reset') ctrl.reset();
    });
  });
}

const roots = document.querySelectorAll<HTMLElement>('.sl');

roots.forEach((root) => {
  const ctrl = makeController(root);
  if (!ctrl) return;

  wireControls(root, ctrl);

  if (reduced) return; // no autoplay teaser; controls still drive it

  let started = false;
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !started) {
          started = true;
          obs.disconnect();
          void teaser(ctrl);
        }
      });
    },
    { threshold: 0.25 },
  );
  obs.observe(root);
});

export {};
