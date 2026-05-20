import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('CLI: restore', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nook-cli-rs-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('restores into an existing empty DB (default)', async () => {
    const srcDb = await open(join(dir, 'src.db'));
    await srcDb.put('c', Buffer.from('k'), Buffer.from('v'));
    await srcDb.backup(join(dir, 'snap.nbkp'));
    srcDb.close();

    // Pre-create an empty destination DB.
    const dst = await open(join(dir, 'dst.db'));
    dst.close();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['restore', join(dir, 'snap.nbkp'), join(dir, 'dst.db')], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);

    const dst2 = await open(join(dir, 'dst.db'));
    const v = await dst2.get('c', Buffer.from('k'));
    expect(v?.toString()).toBe('v');
    dst2.close();
  });

  it('refuses to restore into a non-empty DB without --allow-overwrite (exit 1)', async () => {
    const srcDb = await open(join(dir, 'src.db'));
    await srcDb.put('c', Buffer.from('k'), Buffer.from('snap'));
    await srcDb.backup(join(dir, 'snap.nbkp'));
    srcDb.close();

    const dst = await open(join(dir, 'dst.db'));
    await dst.put('c', Buffer.from('existing'), Buffer.from('1'));
    dst.close();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['restore', join(dir, 'snap.nbkp'), join(dir, 'dst.db')], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(1);
    expect(await collect(stderr)).toMatch(/conflict|not empty/i);
  });

  it('overwrites with --allow-overwrite', async () => {
    const srcDb = await open(join(dir, 'src.db'));
    await srcDb.put('c', Buffer.from('k'), Buffer.from('snap'));
    await srcDb.backup(join(dir, 'snap.nbkp'));
    srcDb.close();

    const dst = await open(join(dir, 'dst.db'));
    await dst.put('c', Buffer.from('existing'), Buffer.from('1'));
    dst.close();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(
      ['restore', join(dir, 'snap.nbkp'), join(dir, 'dst.db'), '--allow-overwrite'],
      { stdout, stderr },
    );
    stdout.end(); stderr.end();
    expect(code).toBe(0);
  });

  it('--create makes the DB file when missing', async () => {
    const srcDb = await open(join(dir, 'src.db'));
    await srcDb.put('c', Buffer.from('k'), Buffer.from('snap'));
    await srcDb.backup(join(dir, 'snap.nbkp'));
    srcDb.close();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(
      ['restore', join(dir, 'snap.nbkp'), join(dir, 'fresh.db'), '--create'],
      { stdout, stderr },
    );
    stdout.end(); stderr.end();
    expect(code).toBe(0);
  });

  it('without --create and missing DB → exit 1', async () => {
    const srcDb = await open(join(dir, 'src.db'));
    await srcDb.put('c', Buffer.from('k'), Buffer.from('snap'));
    await srcDb.backup(join(dir, 'snap.nbkp'));
    srcDb.close();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(
      ['restore', join(dir, 'snap.nbkp'), join(dir, 'absent.db')],
      { stdout, stderr },
    );
    stdout.end(); stderr.end();
    expect(code).toBe(1);
    expect(await collect(stderr)).toMatch(/not found|missing|create/i);
  });

  it('bad CRC backup → exit 1 with corruption error', async () => {
    // Write an obviously-bad file shaped like a backup.
    const badPath = join(dir, 'bad.nbkp');
    await writeFile(badPath, Buffer.alloc(128, 0));
    const dst = await open(join(dir, 'dst.db'));
    dst.close();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['restore', badPath, join(dir, 'dst.db')], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(1);
    expect(await collect(stderr)).toMatch(/corruption|magic|checksum/i);
  });
});
