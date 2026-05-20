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

describe('CLI: migrate', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-cli-mig-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('status on fresh DB prints current_version: 0', async () => {
    const dbPath = join(dir, 'app.db');
    const db = await open(dbPath); db.close();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['migrate', 'status', dbPath], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    const out = await collect(stdout);
    expect(out).toMatch(/current_version:\s*0/);
    expect(out).toMatch(/applied:\s*\[\]/);
  });

  it('up --versions 1,2 then status shows current_version: 2', async () => {
    const dbPath = join(dir, 'app.db');
    const db = await open(dbPath); db.close();

    {
      const stdout = new PassThrough(); const stderr = new PassThrough();
      const code = await run(['migrate', 'up', dbPath, '--versions', '1,2'], { stdout, stderr });
      stdout.end(); stderr.end();
      expect(code).toBe(0);
    }
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const code = await run(['migrate', 'status', dbPath], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    const out = await collect(stdout);
    expect(out).toMatch(/current_version:\s*2/);
  });

  it('up without --versions → exit 2 (usage error)', async () => {
    const dbPath = join(dir, 'app.db');
    const db = await open(dbPath); db.close();
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const code = await run(['migrate', 'up', dbPath], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(2);
  });

  it('rejects --versions with non-numeric token (exit 1)', async () => {
    const dbPath = join(dir, 'app.db');
    const db = await open(dbPath); db.close();
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const code = await run(['migrate', 'up', dbPath, '--versions', '1,abc,3'], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(1);
    expect(await collect(stderr)).toMatch(/version|number|invalid/i);
  });
});
