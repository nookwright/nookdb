import { mkdtemp, rm, stat } from 'node:fs/promises';
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

describe('CLI: backup', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-cli-bk-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('writes a .nbkp file with summary stats', async () => {
    const dbPath = join(dir, 'app.db');
    const db = await open(dbPath);
    await db.put('c', Buffer.from('k'), Buffer.from('v'));
    db.close();

    const out = join(dir, 'snap.nbkp');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['backup', dbPath, out], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    const printed = await collect(stdout);
    expect(printed).toMatch(/entries/);

    const stt = await stat(out);
    expect(stt.size).toBeGreaterThan(0);
  });

  it('missing positional args → usage error exit 2', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['backup'], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(2);
  });

  it('non-existent source DB → exit 1 with error', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // open() creates intermediate directories, so a plain missing path succeeds.
    // Instead create a regular file and use it as a directory component — that
    // reliably forces the native open to fail on all platforms.
    const { writeFile } = await import('node:fs/promises');
    const blocker = join(dir, 'blocker.txt');
    await writeFile(blocker, 'not a directory');
    const invalidDbPath = join(blocker, 'nested.db');
    const code = await run(['backup', invalidDbPath, join(dir, 'out.nbkp')], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(1);
    expect(await collect(stderr)).toMatch(/error/i);
  });
});
