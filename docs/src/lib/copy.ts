export type FamilyStatus = 'active' | 'planned' | 'concept';

export interface FamilyEntry {
  name: string;
  desc: string;
  status: FamilyStatus;
  href: string | null;
}

export interface FaqEntry {
  q: string;
  a: string;
}

// One canonical site URL — used by AiReady's prompt and anywhere else that
// needs to reference an absolute docs URL. Update here when the custom domain
// lands and every reference updates with it.
const SITE_URL = 'https://nookdb.pages.dev';

export const copy = {
  site: {
    url: SITE_URL,
  },
  brand: {
    parent: 'nookwright',
    product: 'nookdb',
  },
  hero: {
    headline: 'Local-first data with a memory.',
    subhead:
      'A schema-first reactive database for Electron, built on a Rust core.',
    install: 'npm install nookdb @nookdb/electron',
    primaryCta: 'Copy install',
    secondaryCta: 'Read the architecture →',
    quickStartCta: 'Quick start →',
    quickStartHref: '/quick-start/',
    versionPill: 'v1.0.0',
    preReleaseNote:
      'v1.0.0 — public API stable under strict SemVer. Breaking changes require a major bump.',
  },
  story: {
    schema: {
      title: 'Schema typed once. Types everywhere.',
      body:
        'Define your data with `s.*`. NookDB infers TypeScript types automatically — no codegen step, no `as` casts, no schema drift.',
    },
    live: {
      title: 'Queries that update themselves.',
      body:
        'Subscribe with `.live()`. When the underlying data changes — anywhere in your app — your callback fires. No polling. No websockets. No refetch.',
      networkFootnote: 'Network requests: 0.',
      mechanism:
        'How it works: a Rust commit notifier wakes matching subscriptions; the query re-runs and emits a fresh snapshot. No polling, no JS-side diffing.',
      caveat:
        'Illustrative demo — your real db.todos.live() runs in your Electron process.',
    },
    bridge: {
      title: 'Stop writing IPC.',
      body:
        'In Electron, data lives in main; UI lives in renderers. NookDB bridges them. Subscribe in any window — the bridge takes care of the rest.',
      beforeLabel: 'Before',
      afterLabel: 'With NookDB',
    },
  },
  whyExists: [
    "Electron apps deserve a database that lives where the app does — on the user's machine, behind the app's own process model.",
    'NookDB is that database: schema-first, reactive across renderers, durable on a Rust core.',
  ],
  architecture: {
    heading: 'How it works.',
    caption:
      'Rust core via `redb 2.x`. `tokio::task::spawn_blocking` bridges sync storage to JS async. Errors are reshaped at each boundary with a `[kind] message` prefix convention.',
    linkLabel: 'Read the full architecture →',
    linkHref: '/architecture/overview/',
  },
  durability: {
    heading: 'Durable by design. Yours by default.',
    crash: {
      kind: 'crash safety',
      title: 'Survives kill -9.',
      body: 'Every committed transaction is fsync-flushed on a Rust core (redb). CI crash-injects — SIGKILL mid-write — and asserts the data is intact on reopen. No torn writes, no corruption.',
    },
    ownership: {
      kind: 'data ownership',
      title: 'Your data is just a file.',
      body: 'No server, no proprietary lock-in. The database is a single file on the user’s disk — copy it, back it up, inspect it. Drop NookDB tomorrow and your data stays right where it is.',
    },
    securityNote:
      'Not encrypted at rest yet — pair it with OS-level disk encryption (FileVault, BitLocker). At-rest encryption is on the roadmap.',
  },
  migration: {
    kicker: 'schema evolution',
    heading: 'Your schema will change. There’s a ledger for that.',
    body: 'NookDB records applied schema versions in a transactional, idempotent ledger kept inside the same file — so shipping a change is tracked, not guessed. The full declarative migration DSL (up / down / backfill) is on the roadmap.',
    code: `const status = await db.migrateStatus()
// → { currentVersion: 0, appliedCount: 0 }

await db.migrateRun([1, 2, 3])  // idempotent
await db.migrateListApplied()
// → [1, 2, 3]`,
    linkLabel: 'Migrations guide →',
    linkHref: '/guides/migrations/',
  },
  aiReady: {
    kicker: 'built for ai-assisted development',
    heading: 'Your assistant already knows NookDB.',
    body: 'Schema-first means your AI works with types, not guesses. Point it at the docs and let it build the whole app.',
    promptLabel: 'paste into your assistant',
    prompt: `Help me build an Electron desktop app with NookDB (npm: nookdb + @nookdb/electron). Read the full docs at ${SITE_URL}/llms-full.txt, then:`,
    copyCta: 'Copy prompt',
    points: [
      {
        title: 'Types guide every completion',
        body: "Your AI can't invent a field that isn't in your schema — `s.*` infers the exact types it autocompletes against.",
      },
      {
        title: 'Errors it can actually fix',
        body: 'Every error is typed and prefixed `[kind] message`. Paste one in; your assistant knows what broke and why.',
      },
      {
        title: 'The whole reference, in one paste',
        body: '`llms.txt` and `llms-full.txt` expose the complete docs as plain text — full context your assistant ingests in one shot.',
      },
    ],
    links: [
      { label: 'llms.txt', href: '/llms.txt' },
      { label: 'llms-full.txt', href: '/llms-full.txt' },
    ],
    upcoming: 'MCP server planned — so Claude / Cursor can pull live schema context natively.',
  },
  whenToUse: {
    heading: 'When NookDB. When not.',
    subhead: "Built for Electron desktop. Honest about what it isn't.",
    yes: {
      heading: 'When to use NookDB',
      // backticks render as <code> via the regex below — keep specifics concrete
      items: [
        'Notes, journals, IDEs, design tools, finance apps — anywhere the user owns the data.',
        'UIs that update themselves when main writes — no `ipcMain.handle`, no manual broadcast.',
        'Offline-first by default — zero network in the hot path, zero ms of sync latency.',
        'Type-safe end-to-end — one schema validated in Rust, inferred across main + renderer.',
      ],
    },
    no: {
      text: "Need browser support, multi-device sync, or a shared server backend? NookDB isn't it.",
      groups: [
        {
          label: 'browser',
          items: [
            { label: 'Dexie', href: 'https://dexie.org/' },
            { label: 'RxDB', href: 'https://rxdb.info/' },
          ],
        },
        {
          label: 'multi-device sync',
          items: [
            { label: 'ElectricSQL', href: 'https://electric-sql.com/' },
            { label: 'Jazz', href: 'https://jazz.tools/' },
          ],
        },
        {
          label: 'server',
          items: [
            { label: 'SQLite', href: 'https://sqlite.org/' },
            { label: 'Postgres', href: 'https://www.postgresql.org/' },
          ],
        },
      ],
    },
    compareLabel: 'Side-by-side comparisons:',
    compareLinks: [
      { label: 'vs Dexie', href: '/compare/dexie/' },
      { label: 'vs RxDB', href: '/compare/rxdb/' },
      { label: 'vs Jazz', href: '/compare/jazz/' },
      { label: 'vs better-sqlite3', href: '/compare/better-sqlite3/' },
    ],
  },
  benchmarks: {
    heading: 'Honest numbers.',
    subhead: "Two bars. One we win. One we don't.",
    tradeoff:
      'Durable fsync’d writes are where NookDB shines — every commit hits disk before resolving. The cost: better-sqlite3 still leads raw reads by roughly 3–13× depending on op. We show one of each.',
    // Footnote is built from results.json at compile time (see component);
    // this line is only the static methodology preamble.
    methodologyPrefix: 'Methodology:',
    methodologyCommand: 'pnpm --filter @nookdb/benchmarks run',
    methodologySuffix:
      'tinybench orchestrates each case; we report hz (ops/sec) and mean (ms/op). Canonical numbers come from the GitHub Actions Ubuntu CI matrix; the dev-machine numbers below are advisory.',
    linkLabel: 'Compare deep-dive: vs better-sqlite3 →',
    linkHref: '/compare/better-sqlite3/',
  },
  family: {
    heading: 'A family of tools for people who build their own software.',
    entries: [
      {
        name: 'NookDB',
        desc: 'Database for Electron desktop apps.',
        status: 'active',
        href: '/',
      },
      {
        name: 'NookJS',
        desc: 'Runtime tooling for desktop builds.',
        status: 'planned',
        href: null,
      },
      {
        name: 'NookSecurity',
        desc: 'Application-layer security primitives.',
        status: 'concept',
        href: null,
      },
    ] satisfies FamilyEntry[],
    founderNote:
      'Nookwright is a family of tools for people who build their own software. NookDB is the first; more to come.',
    founderSignature: '— Ömer',
  },
  faq: {
    heading: 'Questions.',
    entries: [
      {
        q: 'Is this free?',
        a: 'Yes — MIT licensed, fully open source. That includes the whole library: no paywalled core, no feature gate.',
      },
      {
        q: 'Is it production-ready?',
        a: 'Pre-1.0. The core (Rust + redb) is tested with crash-injection. The TypeScript surface is still settling. Pin exact versions if you ship.',
      },
      {
        q: 'Why redb, not SQLite?',
        a: 'Different tradeoffs. redb is pure Rust, lock-free reads, simpler crash semantics. SQLite is unbeatable for SQL workloads. NookDB picked redb for a reason — read the architecture.',
      },
      {
        q: 'Does it sync?',
        a: "No. By design. If you need sync, use ElectricSQL or Jazz on top — they're built for that.",
      },
      {
        q: 'Who builds this?',
        a: 'One person, in public, under Nookwright. NookDB is the database I wanted while shipping my own Electron apps — I build it because I use it. The repo is open. The roadmap is honest.',
      },
      {
        q: 'How do I get help?',
        a: 'GitHub issues — I read every one. No formal SLA, but bugs with a reproduction get attention fast.',
      },
      {
        q: 'Does it phone home?',
        a: 'No. Zero telemetry, zero network requests from the library — NookDB is an embedded local database. The only network traffic is whatever your app does.',
      },
    ] satisfies FaqEntry[],
  },
  installCta: {
    heading: 'Get started.',
    githubLabel: 'Star on GitHub',
    githubHref: 'https://github.com/nookwright/nookdb',
    starterLabel: 'Or clone a working repo:',
    starterRepoName: 'examples/electron-todo',
    starterHref:
      'https://github.com/nookwright/nookdb/tree/main/examples/electron-todo',
    exampleCaption: 'A complete app — schema, write, live query — in one file.',
    example: `import { s, open } from 'nookdb'

const schema = {
  todos: s.collection({
    id: s.id(),
    title: s.string(),
    done: s.boolean(),
  }),
}

const db = await open('app.nook', { schema })

await db.todos.insert({ title: 'ship it', done: false })

// re-renders itself whenever todos change — anywhere
db.todos.live({ done: false }).subscribe(render)`,
  },
  footer: {
    buildLogHeading: 'Last commits',
    links: [
      { label: 'Docs', href: '/quick-start/' },
      { label: 'Architecture', href: '/architecture/overview/' },
      { label: 'GitHub', href: 'https://github.com/nookwright/nookdb' },
      { label: 'Discussions', href: 'https://github.com/nookwright/nookdb/discussions' },
      { label: 'Security', href: 'https://github.com/nookwright/nookdb/security/advisories/new' },
    ],
  },
  nav: {
    links: [
      { label: 'Docs', href: '/quick-start/' },
      { label: 'Architecture', href: '/architecture/overview/' },
      { label: 'GitHub', href: 'https://github.com/nookwright/nookdb' },
    ],
  },
} as const;
