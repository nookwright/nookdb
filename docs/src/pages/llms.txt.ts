// /llms.txt — the LLM-friendly index of the docs, following the llms.txt
// convention (https://llmstxt.org). A title, a one-line summary, then a flat
// list of every doc page with its description and absolute URL. Generated from
// the docs content collection so it never drifts from the real docs.

import type { APIRoute } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';

type Doc = CollectionEntry<'docs'>;

// Sidebar order (astro.config.mjs) so the index reads top-to-bottom like the docs.
const ORDER = [
  'quick-start',
  'guides/schema-dsl',
  'guides/queries',
  'guides/reactive-live',
  'guides/migrations',
  'guides/cli',
  'guides/electron-bridge',
  'guides/backup-restore',
  'guides/migrating-from-sehawq-v5',
  'reference/errors',
  'reference/api',
  'reference/nbkp-format',
  'architecture/overview',
  'compare/rxdb',
  'compare/jazz',
  'compare/dexie',
  'compare/better-sqlite3',
];

const slugify = (id: string) => id.replace(/\.(md|mdx)$/, '');
const rank = (id: string) => {
  const i = ORDER.indexOf(slugify(id));
  return i === -1 ? ORDER.length : i;
};

export const GET: APIRoute = async ({ site }) => {
  const base = (site?.toString() ?? 'https://nookdb.pages.dev/').replace(/\/$/, '');
  const docs = (await getCollection('docs')).sort(
    (a: Doc, b: Doc) => rank(a.id) - rank(b.id),
  );

  const lines = docs.map((d: Doc) => {
    const url = `${base}/${slugify(d.id)}/`;
    const desc = d.data.description ? `: ${d.data.description}` : '';
    return `- [${d.data.title}](${url})${desc}`;
  });

  const body = `# nookdb

> Schema-first, reactive, local-first database for Electron desktop apps. A Rust core (redb 2.x) under a fully-typed TypeScript surface: define your schema once with \`s.*\`, get inferred types everywhere, subscribe to live queries that re-render themselves, and bridge data across Electron processes with one line. MIT licensed.

## Docs

${lines.join('\n')}

## Full text

- [Full documentation, concatenated for ingestion](${base}/llms-full.txt)
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
