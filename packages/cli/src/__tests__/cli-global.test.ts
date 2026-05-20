import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { run } from '../runtime.js';

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

describe('CLI global options', () => {
  it('--version prints package version, exit 0', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['--version'], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    expect(await collect(stdout)).toMatch(/^\S+/);
  });

  it('--help prints usage to stdout, exit 0', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['--help'], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(0);
    const out = await collect(stdout);
    expect(out).toMatch(/Usage:/);
    // commands listed will be added in later tasks; for T19 only the program metadata is in
  });

  it('unknown command exits 2 with an error message', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await run(['bogus'], { stdout, stderr });
    stdout.end(); stderr.end();
    expect(code).toBe(2);
    expect(await collect(stderr)).toMatch(/unknown command|invalid|error/i);
  });
});
