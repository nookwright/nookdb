import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSchema } from '../schema-loader.js';

describe('schema-loader', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-loader-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('loads a .json descriptor', async () => {
    const file = join(dir, 'schema.json');
    await writeFile(file, JSON.stringify({ kind: 'fixture', collections: ['x'] }));
    const loaded = (await loadSchema(file)) as { kind: string };
    expect(loaded.kind).toBe('fixture');
  });

  it('loads a .ts file via tsx', async () => {
    const file = join(dir, 'schema.ts');
    await writeFile(
      file,
      `export const schema = { hello: 'world' as const };\nexport default schema;\n`,
    );
    const loaded = (await loadSchema(file)) as { hello: string };
    expect(loaded.hello).toBe('world');
  });

  it('throws when the file does not exist', async () => {
    await expect(loadSchema(join(dir, 'no.ts'))).rejects.toThrow();
  });
});
