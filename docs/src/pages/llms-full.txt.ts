// /llms-full.txt — the entire documentation concatenated into one plain-text
// markdown file, so a developer can paste it straight into their AI assistant
// (or point the assistant at this URL) and have full, correct context for
// building with NookDB. Generated from the docs content collection.

import type { APIRoute } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';

type Doc = CollectionEntry<'docs'>;

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

// Strip MDX scaffolding that isn't useful as prose to an LLM: import statements
// and Starlight component tags (keeping their inner text content).
function toPlainMarkdown(raw: string): string {
  return raw
    .replace(/^import\s.+?;?\s*$/gm, '') // import lines
    .replace(/<\/?(Steps|Aside|Tabs|TabItem|Card|CardGrid|LinkCard|Badge|FileTree|Icon)\b[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n') // collapse the blank lines those leave behind
    .trim();
}

export const GET: APIRoute = async ({ site }) => {
  const base = (site?.toString() ?? 'https://nookdb.pages.dev/').replace(/\/$/, '');
  const docs = (await getCollection('docs')).sort(
    (a: Doc, b: Doc) => rank(a.id) - rank(b.id),
  );

  const sections = docs.map((d: Doc) => {
    const url = `${base}/${slugify(d.id)}/`;
    const summary = d.data.description ? `> ${d.data.description}\n\n` : '';
    return `# ${d.data.title}\n\nSource: ${url}\n\n${summary}${toPlainMarkdown(d.body ?? '')}`;
  });

  const body = `# nookdb — full documentation

> Schema-first, reactive, local-first database for Electron desktop apps, built on a Rust core (redb 2.x). This file concatenates the complete documentation for AI assistants. Paste it into your tool of choice, or point your assistant at ${base}/llms-full.txt.

${sections.join('\n\n---\n\n')}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
