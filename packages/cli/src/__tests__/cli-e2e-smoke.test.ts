import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from 'nookdb';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', '..', 'bin', 'nookdb.mjs');

describe('CLI smoke E2E (real bin via execa)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-smoke-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('--version prints something, exit 0', async () => {
    const { stdout, exitCode } = await execa('node', [BIN, '--version']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\S/);
  });

  it('backup → restore via real bin', async () => {
    const dbPath = join(dir, 'src.db');
    const db = await open(dbPath);
    await db.put('c', Buffer.from('k'), Buffer.from('v'));
    db.close();

    const snap = join(dir, 'snap.nbkp');
    {
      const r = await execa('node', [BIN, 'backup', dbPath, snap]);
      expect(r.exitCode).toBe(0);
    }
    const dstPath = join(dir, 'dst.db');
    const dst = await open(dstPath); dst.close();
    {
      const r = await execa('node', [BIN, 'restore', snap, dstPath]);
      expect(r.exitCode).toBe(0);
    }
    const verify = await open(dstPath);
    const v = await verify.get('c', Buffer.from('k'));
    expect(v?.toString()).toBe('v');
    verify.close();
  });

  it('migrate status on fresh DB', async () => {
    const dbPath = join(dir, 'fresh.db');
    const db = await open(dbPath); db.close();
    const { stdout, exitCode } = await execa('node', [BIN, 'migrate', 'status', dbPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/current_version:\s*0/);
  });

  it('inspect prints structure', async () => {
    const dbPath = join(dir, 'i.db');
    const db = await open(dbPath);
    await db.put('users', Buffer.from('a'), Buffer.from('x'));
    db.close();
    const { stdout, exitCode } = await execa('node', [BIN, 'inspect', dbPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Collections:/);
  });

  it('unknown command → exit 2', async () => {
    const r = await execa('node', [BIN, 'bogus'], { reject: false });
    expect(r.exitCode).toBe(2);
  });
});
