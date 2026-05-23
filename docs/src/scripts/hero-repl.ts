// hero-repl.ts — drives the interactive NookDB shell in the hero.
//
// A native <input> captures one command; on Enter it runs inside a Web Worker
// (faithful JS sim of the NookDB API, 1s watchdog) and the result renders into
// the append-only scrollback as a table / value / error. Up/Down recall
// history. The worker computes a structured-clone-safe display model so the
// main thread stays a dumb renderer.

// ── Worker source (plain JS string → Blob → Worker) ─────────────────────────
const WORKER_SRC = `
self.onmessage = function (e) {
  var code = String(e.data || '').trim().replace(/;+$/, '');
  var SEED = { todos: [
    { id: 1, title: 'buy milk',     done: false },
    { id: 2, title: 'walk dog',     done: true  },
    { id: 3, title: 'water plants', done: false }
  ] };
  var logs = [];

  function fmt(v) {
    if (typeof v === 'string') return "'" + v + "'";
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return '[ ' + v.map(fmt).join(', ') + ' ]';
    if (typeof v === 'object') {
      return '{ ' + Object.keys(v).map(function (k) { return k + ': ' + fmt(v[k]); }).join(', ') + ' }';
    }
    return String(v);
  }
  function fmtTop(v) { return (typeof v === 'string') ? v : fmt(v); }
  function cell(v) {
    if (typeof v === 'string') return v;
    if (v === null) return 'null';
    if (v === undefined) return '';
    return String(v);
  }

  var sandboxConsole = {
    log:   function () { logs.push({ level: 'log',   text: [].map.call(arguments, fmtTop).join(' ') }); },
    warn:  function () { logs.push({ level: 'warn',  text: [].map.call(arguments, fmtTop).join(' ') }); },
    error: function () { logs.push({ level: 'error', text: [].map.call(arguments, fmtTop).join(' ') }); }
  };

  function makeQuery(rows) {
    var arr = rows.slice();
    function def(name, fn) { Object.defineProperty(arr, name, { value: fn, enumerable: false }); }
    def('where',   function (p) { return makeQuery(arr.filter(p)); });
    def('orderBy', function (f, dir) {
      var s = arr.slice().sort(function (a, b) { return a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0; });
      if (dir === 'desc') s.reverse();
      return makeQuery(s);
    });
    def('limit',   function (n) { return makeQuery(arr.slice(0, n)); });
    def('toArray', function () { return arr.slice(); });
    def('live',    function () { return makeQuery(arr); });
    def('first',   function () { return arr[0]; });
    def('count',   function () { return arr.length; });
    return arr;
  }

  function buildCollection(name, store, seq) {
    var q = makeQuery(store[name]);
    Object.defineProperty(q, 'insert', { enumerable: false, value: function (obj) {
      var id = seq[name]++;
      var row = Object.assign({ id: id, done: false }, obj);
      store[name].push(row);
      return Promise.resolve({ id: id });
    } });
    return q;
  }

  function buildDb(store, seq) {
    var db = {};
    Object.keys(store).forEach(function (name) {
      Object.defineProperty(db, name, { enumerable: true, get: function () { return buildCollection(name, store, seq); } });
    });
    return db;
  }

  var noop = function () { return {}; };
  var s = { collection: function (f) { return { __schema: f }; },
            id: noop, string: noop, boolean: noop, number: noop, timestamp: noop, json: noop, array: noop };

  var store = JSON.parse(JSON.stringify(SEED));
  var seq = {};
  Object.keys(store).forEach(function (n) {
    seq[n] = store[n].reduce(function (m, r) { return Math.max(m, r.id); }, 0) + 1;
  });
  var db = buildDb(store, seq);

  function toDisplay(result) {
    if (Array.isArray(result)) {
      if (result.length === 0) return { kind: 'table', columns: [], rows: [] };
      var first = result[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        var cols = [];
        result.forEach(function (r) {
          Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
        });
        var rows = result.map(function (r) { return cols.map(function (c) { return cell(r[c]); }); });
        return { kind: 'table', columns: cols, rows: rows };
      }
      return { kind: 'value', text: '[ ' + result.map(fmt).join(', ') + ' ]' };
    }
    if (result === undefined) return { kind: 'empty' };
    return { kind: 'value', text: fmt(result) };
  }

  (async function () {
    var fn;
    try {
      // Try expression form first (so a bare query yields a result value).
      fn = new Function('db', 's', 'console', '"use strict"; return (async () => { return (\\n' + code + '\\n); })();');
    } catch (syntaxErr) {
      // Fall back to statement form (e.g. multiple statements, no return value).
      try {
        fn = new Function('db', 's', 'console', '"use strict"; return (async () => {\\n' + code + '\\n})();');
      } catch (err2) {
        self.postMessage({ logs: logs, error: (err2 && err2.message) ? err2.message : String(err2), display: { kind: 'empty' } });
        return;
      }
    }
    try {
      var result = await fn(db, s, sandboxConsole);
      self.postMessage({ logs: logs, display: toDisplay(result) });
    } catch (err) {
      self.postMessage({ logs: logs, error: (err && err.message) ? err.message : String(err), display: { kind: 'empty' } });
    }
  })();
};
`;

interface LogLine { level: 'log' | 'warn' | 'error'; text: string; }
interface Display {
  kind: 'table' | 'value' | 'empty';
  columns?: string[];
  rows?: string[][];
  text?: string;
}
interface RunResult { logs: LogLine[]; error?: string; display: Display; }

const logEl = document.querySelector<HTMLElement>('[data-log]');
const formEl = document.querySelector<HTMLFormElement>('[data-form]');
const inputEl = document.querySelector<HTMLInputElement>('[data-input]');
const examplesEl = document.querySelector<HTMLElement>('[data-examples]');

if (logEl && formEl && inputEl) {
  const WORKER_URL = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
  let worker: Worker | null = null;
  let killTimer = 0;
  let busy = false;
  let pendingResult: HTMLElement | null = null;

  const history: string[] = [];
  let histIdx = -1;

  // ── Syntax highlight (read-only echoed command — safe, no overlay) ────
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const TOKEN =
    /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|var|await|async|return|true|false|null|new)\b|\b(db|s|console)\b|\.(where|orderBy|limit|toArray|live|first|count|insert|forEach|map|filter|log|warn|error)\b|\b(\d+)\b/g;

  function highlight(src: string): string {
    return esc(src).replace(TOKEN, (m, str, kw, builtin, method, num) => {
      if (str) return `<span class="t-string">${str}</span>`;
      if (kw) return `<span class="t-keyword">${kw}</span>`;
      if (builtin) return `<span class="t-builtin">${builtin}</span>`;
      if (method) return `.<span class="t-method">${method}</span>`;
      if (num) return `<span class="t-number">${num}</span>`;
      return m;
    });
  }

  function scrollToEnd(): void {
    logEl!.scrollTop = logEl!.scrollHeight;
  }

  /** Echo the command and return the (empty) result container to fill later. */
  function appendEntry(cmd: string): HTMLElement {
    const entry = document.createElement('div');
    entry.className = 'repl__entry';

    const cmdRow = document.createElement('div');
    cmdRow.className = 'repl__cmd';
    const prompt = document.createElement('span');
    prompt.className = 'repl__prompt';
    prompt.textContent = 'nook>';
    const code = document.createElement('code');
    code.innerHTML = highlight(cmd);
    cmdRow.append(prompt, code);

    const result = document.createElement('div');
    result.className = 'repl__result';

    entry.append(cmdRow, result);
    logEl!.appendChild(entry);
    scrollToEnd();
    return result;
  }

  function renderResult(target: HTMLElement, data: RunResult): void {
    target.replaceChildren();

    for (const l of data.logs) {
      const line = document.createElement('div');
      line.className = `repl__logline repl__logline--${l.level}`;
      line.textContent = l.text;
      target.appendChild(line);
    }

    if (data.error) {
      const e = document.createElement('div');
      e.className = 'repl__error';
      e.textContent = `⚠ ${data.error}`;
      target.appendChild(e);
      scrollToEnd();
      return;
    }

    const d = data.display;
    if (d.kind === 'table') {
      const cols = d.columns ?? [];
      const rows = d.rows ?? [];
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'repl__meta';
        empty.textContent = '0 rows · 0 network requests';
        target.appendChild(empty);
      } else {
        const table = document.createElement('table');
        table.className = 'repl__table';
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        for (const c of cols) {
          const th = document.createElement('th');
          th.textContent = c;
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        const tbody = document.createElement('tbody');
        for (const r of rows) {
          const tr = document.createElement('tr');
          tr.classList.add('is-new');
          for (const cellText of r) {
            const td = document.createElement('td');
            td.textContent = cellText;
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.append(thead, tbody);
        target.appendChild(table);

        const meta = document.createElement('div');
        meta.className = 'repl__meta';
        meta.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} · 0 network requests`;
        target.appendChild(meta);
      }
    } else if (d.kind === 'value') {
      const v = document.createElement('div');
      v.className = 'repl__value';
      v.textContent = `→ ${d.text}`;
      target.appendChild(v);
    } else if (data.logs.length === 0) {
      const v = document.createElement('div');
      v.className = 'repl__meta';
      v.textContent = 'ok';
      target.appendChild(v);
    }
    scrollToEnd();
  }

  // ── Worker lifecycle ──────────────────────────────────────────────────
  function spawnWorker(): Worker {
    const w = new Worker(WORKER_URL);
    w.onmessage = (e: MessageEvent) => {
      window.clearTimeout(killTimer);
      busy = false;
      if (pendingResult) renderResult(pendingResult, e.data as RunResult);
      pendingResult = null;
    };
    return w;
  }

  function run(cmd: string): void {
    if (busy) return;
    busy = true;
    pendingResult = appendEntry(cmd);
    if (!worker) worker = spawnWorker();
    worker.postMessage(cmd);
    window.clearTimeout(killTimer);
    killTimer = window.setTimeout(() => {
      // Watchdog: kill a runaway run and recover.
      if (worker) { worker.terminate(); worker = null; }
      busy = false;
      if (pendingResult) {
        renderResult(pendingResult, {
          logs: [],
          error: 'execution timed out (possible infinite loop)',
          display: { kind: 'empty' },
        });
      }
      pendingResult = null;
    }, 1000);
  }

  // ── Built-in commands (handled on the main thread, not the worker) ────
  const HELP_ROWS: { cmd: string; desc: string }[] = [
    { cmd: 'db.todos.toArray()', desc: 'every row' },
    { cmd: "db.todos.where(t => !t.done)", desc: 'filter with a predicate' },
    { cmd: "db.todos.orderBy('title', 'desc')", desc: 'sort by a field' },
    { cmd: 'db.todos.limit(2)', desc: 'take the first N' },
    { cmd: 'db.todos.first()', desc: 'the first row' },
    { cmd: 'db.todos.count()', desc: 'how many rows' },
    { cmd: "await db.todos.insert({ title: 'ship v1' })", desc: 'add a row' },
    { cmd: "console.log('hi', db.todos.count())", desc: 'print to output' },
  ];

  function appendHelp(): void {
    const target = appendEntry('help');

    const intro = document.createElement('div');
    intro.className = 'repl__help-intro';
    intro.innerHTML =
      'Commands — click any to run. The collection <code>todos</code> is preloaded with sample rows.';

    const list = document.createElement('ul');
    list.className = 'repl__help-list';
    for (const row of HELP_ROWS) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'repl__help-cmd';
      btn.dataset.ex = row.cmd;
      btn.innerHTML = highlight(row.cmd);
      const desc = document.createElement('span');
      desc.className = 'repl__help-desc';
      desc.textContent = `— ${row.desc}`;
      li.append(btn, desc);
      list.appendChild(li);
    }

    const foot = document.createElement('div');
    foot.className = 'repl__help-foot';
    foot.innerHTML = 'also: <code>clear</code> to reset · <code>↑</code>/<code>↓</code> for history';

    const help = document.createElement('div');
    help.className = 'repl__help';
    help.append(intro, list, foot);
    target.appendChild(help);
    scrollToEnd();
  }

  function clearLog(): void {
    logEl!.querySelectorAll('.repl__entry').forEach((e) => e.remove());
  }

  /** Route a command: built-ins (help/clear) run locally; everything else
   *  goes to the sandboxed worker. */
  function dispatch(raw: string): void {
    const cmd = raw.trim();
    if (!cmd) return;
    const lc = cmd.toLowerCase();

    if (lc === 'help' || lc === '?' || lc === 'help()') {
      history.push(cmd);
      histIdx = history.length;
      appendHelp();
      return;
    }
    if (lc === 'clear' || lc === 'cls') {
      history.push(cmd);
      histIdx = history.length;
      clearLog();
      return;
    }
    if (busy) return;
    history.push(cmd);
    histIdx = history.length;
    run(cmd);
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = inputEl!.value.trim();
    if (!cmd) return;
    inputEl!.value = '';
    dispatch(cmd);
  });

  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      if (histIdx > 0) {
        histIdx -= 1;
        inputEl!.value = history[histIdx] ?? '';
        e.preventDefault();
      }
    } else if (e.key === 'ArrowDown') {
      if (histIdx < history.length - 1) {
        histIdx += 1;
        inputEl!.value = history[histIdx] ?? '';
      } else {
        histIdx = history.length;
        inputEl!.value = '';
      }
      e.preventDefault();
    }
  });

  // Example chips + clickable commands inside the help block both dispatch.
  function onChipClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ex]');
    if (!btn) return;
    const cmd = btn.dataset.ex ?? '';
    if (!cmd) return;
    dispatch(cmd);
    inputEl!.focus();
  }

  examplesEl?.addEventListener('click', onChipClick);
  logEl.addEventListener('click', onChipClick);
}

export {};
