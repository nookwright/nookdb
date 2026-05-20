import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare global {
  interface Window {
    __nook: {
      connect(): Promise<{ ok: boolean; name?: string; message?: string }>;
      insertAdmin(id: string): Promise<{ ok: boolean; name?: string; message?: string }>;
      findAdmins(): Promise<Array<{ id: string; role: string }>>;
      liveStart(): Promise<void>;
      liveSnaps(): Promise<number[]>;
      liveDispose(): Promise<void>;
      disconnect(): Promise<void>;
      getSetupError(): Promise<string | null>;
    };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mainEntry = path.resolve(__dirname, 'fixtures', 'main.cjs');

type Mode = 'happy' | 'mismatch' | 'deny';

async function launch(mode: Mode): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    env: { ...process.env, NOOK_E2E_MODE: mode },
  });
}

/**
 * Wait until the preload's async setup() has completed.
 * The preload resolves a setupComplete promise that all API methods await.
 * We call getSetupError() to detect failures; null means success.
 *
 * Because contextBridge exposeInMainWorld is synchronous, window.__nook
 * is available immediately in the renderer, but methods internally await setup.
 * waitForNook just ensures the first getSetupError() call doesn't timeout.
 */
async function waitForNook(win: Page): Promise<void> {
  // Wait for the window.__nook object to appear (contextBridge registers it)
  await win.waitForFunction(() => typeof window.__nook !== 'undefined', undefined, {
    timeout: 10_000,
    polling: 100,
  });

  // Then wait for setup to either succeed or fail (getSetupError resolves either way)
  const err = await win.evaluate(() => window.__nook.getSetupError());
  if (err !== null) {
    throw new Error(`Preload setup failed: ${err}`);
  }
}

// ─── Scenario 1: Handshake success + CRUD + persistence ──────────────────────

test('handshake success + CRUD + persistence', async () => {
  const app = await launch('happy');
  try {
    const win = await app.firstWindow();
    await waitForNook(win);

    const connectResult = await win.evaluate(() => window.__nook.connect());
    expect(connectResult.ok).toBe(true);

    await win.evaluate(() => window.__nook.insertAdmin('u1'));

    const admins = await win.evaluate(() => window.__nook.findAdmins());
    expect(admins.length).toBe(1);
    expect(admins[0]!.role).toBe('admin');
  } finally {
    await app.close();
  }
});

// ─── Scenario 2: Constraint-only descriptor mismatch → NookSchemaError ───────

test('constraint-only descriptor mismatch throws NookSchemaError', async () => {
  const app = await launch('mismatch');
  try {
    const win = await app.firstWindow();
    await waitForNook(win);

    const connectResult = await win.evaluate(() => window.__nook.connect());
    expect(connectResult.ok).toBe(false);
    expect(connectResult.name).toBe('NookSchemaError');
  } finally {
    await app.close();
  }
});

// ─── Scenario 3: Cross-process live snapshots ─────────────────────────────────

test('cross-process live snapshots arrive', async () => {
  const app = await launch('happy');
  try {
    const win = await app.firstWindow();
    await waitForNook(win);

    await win.evaluate(() => window.__nook.connect());
    await win.evaluate(() => window.__nook.liveStart());

    await win.evaluate(() => window.__nook.insertAdmin('a1'));
    await win.evaluate(() => window.__nook.insertAdmin('a2'));

    // Wait for live emissions to settle (M3 retro: 200ms non-flaky pattern)
    await new Promise<void>((r) => setTimeout(r, 300));

    const snaps = await win.evaluate(() => window.__nook.liveSnaps());
    expect(snaps.at(-1)).toBe(2);

    await win.evaluate(() => window.__nook.liveDispose());
  } finally {
    await app.close();
  }
});

// ─── Scenario 4: Authorizer-deny → NookForbiddenError ────────────────────────

test('authorizer-deny throws NookForbiddenError in renderer', async () => {
  const app = await launch('deny');
  try {
    const win = await app.firstWindow();
    await waitForNook(win);

    const connectResult = await win.evaluate(() => window.__nook.connect());
    expect(connectResult.ok).toBe(true);

    // insertAdmin returns { ok, name, message } — contextBridge cannot propagate
    // custom error names (it flattens all errors to plain Error), so the preload
    // returns the error descriptor as a plain object instead of throwing.
    const result = await win.evaluate(() => window.__nook.insertAdmin('x1'));

    expect(result.ok).toBe(false);
    expect(result.name).toBe('NookForbiddenError');
  } finally {
    await app.close();
  }
});

// ─── Scenario 5: Disconnect drains host without error ─────────────────────────

test('disconnect drains host without error', async () => {
  const app = await launch('happy');
  let closed = false;
  try {
    const win = await app.firstWindow();
    await waitForNook(win);

    await win.evaluate(() => window.__nook.connect());
    await win.evaluate(() => window.__nook.disconnect());

    await app.close();
    closed = true;
  } finally {
    if (!closed) {
      try { await app.close(); } catch { /* already closed */ }
    }
  }
});
