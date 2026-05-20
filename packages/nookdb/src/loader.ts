import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type SupportedPlatform = 'win32' | 'darwin' | 'linux';
export type SupportedArch = 'x64' | 'arm64';
export type SupportedLibc = 'glibc' | 'musl' | null;

export interface PlatformDescriptor {
  platform: SupportedPlatform | (string & NonNullable<unknown>);
  arch: SupportedArch | (string & NonNullable<unknown>);
  libc: SupportedLibc;
}

export class NookError extends Error {
  override readonly name: string = 'NookError';
  constructor(message: string) {
    super(message);
    // Restore the prototype chain after `super(message)` so `instanceof`
    // works in environments that transpile `class` to ES5 functions
    // (sub-ES2015 targets). On ES2022 emit this is a no-op but harmless.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NookPlatformError extends NookError {
  override readonly name = 'NookPlatformError';
  constructor(
    message: string,
    public readonly descriptor: PlatformDescriptor,
  ) {
    super(message);
    Object.setPrototypeOf(this, NookPlatformError.prototype);
  }
}

const SUPPORTED_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  'win32:x64:null': '@nookdb/core-win32-x64-msvc',
  'win32:arm64:null': '@nookdb/core-win32-arm64-msvc',
  'darwin:x64:null': '@nookdb/core-darwin-x64',
  'darwin:arm64:null': '@nookdb/core-darwin-arm64',
  'linux:x64:glibc': '@nookdb/core-linux-x64-gnu',
  'linux:arm64:glibc': '@nookdb/core-linux-arm64-gnu',
});

/**
 * Maps a runtime platform descriptor to the npm package name that ships
 * the precompiled binding for that target.
 *
 * Throws {@link NookPlatformError} when the target is not in the v1
 * support matrix.
 */
export function resolveBindingPackageName(descriptor: PlatformDescriptor): string {
  const key = `${descriptor.platform}:${descriptor.arch}:${descriptor.libc ?? 'null'}`;
  const pkg = SUPPORTED_TARGETS[key];
  if (pkg === undefined) {
    throw new NookPlatformError(
      `Nook does not ship a prebuilt binary for platform '${descriptor.platform}-${descriptor.arch}'${
        descriptor.libc ? ` (libc=${descriptor.libc})` : ''
      }. Supported targets: ${Object.values(SUPPORTED_TARGETS).join(', ')}. To use Nook on this platform, install Rust and run with --build-from-source.`,
      descriptor,
    );
  }
  return pkg;
}

/**
 * Detects the current platform descriptor from `process`.
 *
 * `libc` is currently a stub: glibc on Linux, null elsewhere. M5 will
 * implement musl detection (probably via `process.report.getReport()`).
 */
export function detectPlatform(): PlatformDescriptor {
  const platform = process.platform;
  const arch = process.arch;
  const libc: SupportedLibc = platform === 'linux' ? 'glibc' : null;
  return { platform, arch, libc };
}

interface BindingModule {
  // Class constructors get exposed via the napi-rs generated `index.js` as
  // properties of the module object. We type the shape minimally; the real
  // Database type lives in `database.ts`.
  Database: unknown;
}

let cachedBinding: BindingModule | null = null;

/**
 * Loads the platform-appropriate native binding. The result is cached;
 * subsequent calls return the same instance.
 *
 * In M0 the loader has a special-case fallback: if the published per-
 * platform package is not installed (because we haven't built the
 * release pipeline yet), it tries to require the in-tree dev build at
 * `@nookdb/binding`. This fallback will be removed in M5.
 */
export function loadBinding(): BindingModule {
  if (cachedBinding !== null) {
    return cachedBinding;
  }

  const descriptor = detectPlatform();
  const primaryPackage = resolveBindingPackageName(descriptor);

  try {
    cachedBinding = require(primaryPackage) as BindingModule;
    return cachedBinding;
  } catch (primaryErr) {
    // M0 fallback: in-tree dev binding
    try {
      cachedBinding = require('@nookdb/binding') as BindingModule;
      return cachedBinding;
    } catch (fallbackErr) {
      throw new NookPlatformError(
        `Failed to load Nook native binding. Tried '${primaryPackage}' and the dev fallback '@nookdb/binding'. Did you run \`pnpm build:napi\`? Original error: ${
          (primaryErr as Error).message
        }`,
        descriptor,
      );
    }
  }
}
