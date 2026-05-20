import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from 'nookdb';
import { run } from '../runtime.js';

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

describe('CLI: inspect', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-cli-ins-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('prints path, size, migration ledger summary, and collections', async () => {
    const dbPath = join(dir, 'app.db');
    const db = await open(dbPath);
    await db.put('users', Buffer.from('alice'), Buffer.from('a'));
    await db.put('users', Buffer.from('bob'),   Buffer.from('b'));
    await db.put('posts', Buffer.from('p1'),    Buffer.from('h'));
    db.close();

    const stdout = new PassThrough(); const stderr = new PassThrough();
    const code = await run(['inspect', dbPath], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    const out = await collect(stdout);
    expect(out).toMatch(/Path:/);
    expect(out).toMatch(/File size:/);
    expect(out).toMatch(/Migration:/);
    expect(out).toMatch(/Collections:/);
    expect(out).toMatch(/users\s+2 entries/);
    expect(out).toMatch(/posts\s+1 entry/);
  });

  it('non-existent DB → exit 1', async () => {
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const code = await run(['inspect', join(dir, 'absent.db')], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(1);
  });

  it('empty DB still prints the structure', async () => {
    const dbPath = join(dir, 'empty.db');
    const db = await open(dbPath); db.close();
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const code = await run(['inspect', dbPath], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    const out = await collect(stdout);
    expect(out).toMatch(/Collections:/);
  });
});
