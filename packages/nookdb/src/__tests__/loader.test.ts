import { describe, expect, it } from 'vitest';
import { resolveBindingPackageName, NookPlatformError } from '../loader.js';

describe('resolveBindingPackageName', () => {
  it('returns the correct package name for win32-x64', () => {
    expect(resolveBindingPackageName({ platform: 'win32', arch: 'x64', libc: null })).toBe(
      '@nookdb/core-win32-x64-msvc',
    );
  });

  it('returns the correct package name for win32-arm64', () => {
    expect(resolveBindingPackageName({ platform: 'win32', arch: 'arm64', libc: null })).toBe(
      '@nookdb/core-win32-arm64-msvc',
    );
  });

  it('returns the correct package name for darwin-x64', () => {
    expect(resolveBindingPackageName({ platform: 'darwin', arch: 'x64', libc: null })).toBe(
      '@nookdb/core-darwin-x64',
    );
  });

  it('returns the correct package name for darwin-arm64', () => {
    expect(resolveBindingPackageName({ platform: 'darwin', arch: 'arm64', libc: null })).toBe(
      '@nookdb/core-darwin-arm64',
    );
  });

  it('returns the correct package name for linux-x64-gnu', () => {
    expect(resolveBindingPackageName({ platform: 'linux', arch: 'x64', libc: 'glibc' })).toBe(
      '@nookdb/core-linux-x64-gnu',
    );
  });

  it('returns the correct package name for linux-arm64-gnu', () => {
    expect(resolveBindingPackageName({ platform: 'linux', arch: 'arm64', libc: 'glibc' })).toBe(
      '@nookdb/core-linux-arm64-gnu',
    );
  });

  it('throws NookPlatformError for unsupported musl linux', () => {
    expect(() =>
      resolveBindingPackageName({ platform: 'linux', arch: 'x64', libc: 'musl' }),
    ).toThrow(NookPlatformError);
  });

  it('throws NookPlatformError for unsupported FreeBSD', () => {
    expect(() =>
      // @ts-expect-error: deliberately passing an unsupported platform
      resolveBindingPackageName({ platform: 'freebsd', arch: 'x64', libc: null }),
    ).toThrow(NookPlatformError);
  });

  it('throws NookPlatformError for unsupported arch on darwin', () => {
    expect(() =>
      // @ts-expect-error: deliberately passing an unsupported arch
      resolveBindingPackageName({ platform: 'darwin', arch: 'ia32', libc: null }),
    ).toThrow(NookPlatformError);
  });
});
