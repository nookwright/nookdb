import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads a schema descriptor from a file path.
 *
 * `.json` is parsed directly; `.ts` / `.js` / `.mjs` / `.cjs` are
 * evaluated via tsx's programmatic API so a user's `schema.ts` can be
 * loaded without a separate compile step. Returns `default` if present,
 * otherwise `schema`, otherwise the module namespace.
 */
export async function loadSchema(filePath: string): Promise<unknown> {
  const ext = extname(filePath);
  if (ext === '.json') {
    const buf = await readFile(filePath, 'utf8');
    return JSON.parse(buf);
  }
  const { tsImport } = (await import('tsx/esm/api')) as {
    tsImport: (specifier: string, parent: string) => Promise<Record<string, unknown>>;
  };
  const specifier = pathToFileURL(filePath).href;
  const mod = await tsImport(specifier, pathToFileURL(import.meta.url).href);
  // tsx CJS interop wraps the module: mod.default is the module namespace,
  // so the real ES default export lives at mod.default.default.
  const inner = (mod as { default?: unknown }).default;
  const realDefault =
    inner !== null &&
    typeof inner === 'object' &&
    'default' in (inner as object)
      ? (inner as { default: unknown }).default
      : inner;
  return (
    realDefault ??
    (mod as { schema?: unknown }).schema ??
    mod
  );
}
