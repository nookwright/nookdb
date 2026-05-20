#!/usr/bin/env tsx
//
// Convert a sehawq.db v5 JSON export into a new nookdb database.
//
// Usage:
//   tsx convert.ts <sehawq.json> <schema.ts> <dest.db>
//
// The script assumes the v5 JSON has the shape
//   { "version": 5, "data": { "<collection>::<id>": <record>, ... } }
// (the most common v5 export shape; adapt the key split if your export
// differs). Records that fail schema validation are skipped and counted
// in the final report.
//
// This is the manual migration tool — there is no `nookdb import` CLI
// command (see PRD §11 revised). Limitations: no .log/WAL replay, no
// schema inference, your `<schema.ts>` must export `default` matching
// the v5 collections.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open, type SchemaShape } from 'nookdb';

interface V5Export {
  version: number;
  data: Record<string, unknown>;
}

interface Report {
  imported: number;
  skipped: number;
  perCollection: Record<string, { imported: number; skipped: number; reasons: string[] }>;
}

async function loadSchema(path: string): Promise<SchemaShape> {
  const { tsImport } = (await import('tsx/esm/api')) as {
    tsImport: (specifier: string, parent: string) => Promise<Record<string, unknown>>;
  };
  const mod = await tsImport(resolve(path), pathToFileURL(import.meta.url).href);
  const schema = (mod as { default?: unknown }).default ?? (mod as { schema?: unknown }).schema;
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`schema file at ${path} must export default (or named 'schema') an object`);
  }
  return schema as SchemaShape;
}

function splitKey(k: string): { collection: string; id: string } | null {
  const sep = k.indexOf('::');
  if (sep <= 0) return null;
  return { collection: k.slice(0, sep), id: k.slice(sep + 2) };
}

async function main(): Promise<number> {
  const [srcPath, schemaPath, destPath] = process.argv.slice(2);
  if (!srcPath || !schemaPath || !destPath) {
    console.error('usage: tsx convert.ts <sehawq.json> <schema.ts> <dest.db>');
    return 2;
  }

  const raw = readFileSync(srcPath, 'utf8');
  const dump = JSON.parse(raw) as V5Export;
  if (dump.version !== 5 || typeof dump.data !== 'object' || dump.data === null) {
    console.error(`not a sehawq.db v5 export (version=${dump.version})`);
    return 1;
  }

  const schema = await loadSchema(schemaPath);
  const db = await open(destPath, { schema });

  const report: Report = { imported: 0, skipped: 0, perCollection: {} };
  for (const [key, value] of Object.entries(dump.data)) {
    const split = splitKey(key);
    if (split === null) {
      report.skipped += 1;
      continue;
    }
    const { collection } = split;
    const slot = (report.perCollection[collection] ??= { imported: 0, skipped: 0, reasons: [] });
    const coll = (db as unknown as Record<string, { insert(d: unknown): Promise<void> }>)[collection];
    if (typeof coll?.insert !== 'function') {
      slot.skipped += 1;
      slot.reasons.push(`no collection ${collection} in schema`);
      report.skipped += 1;
      continue;
    }
    try {
      await coll.insert(value);
      slot.imported += 1;
      report.imported += 1;
    } catch (err) {
      slot.skipped += 1;
      slot.reasons.push((err as Error).message);
      report.skipped += 1;
    }
  }

  db.close();

  console.log(`Imported: ${report.imported} record(s)`);
  console.log(`Skipped:  ${report.skipped} record(s)`);
  for (const [coll, slot] of Object.entries(report.perCollection)) {
    console.log(`  ${coll}: ${slot.imported} imported / ${slot.skipped} skipped`);
    const uniqueReasons = [...new Set(slot.reasons)];
    for (const r of uniqueReasons.slice(0, 3)) console.log(`    • ${r}`);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
