'use strict';
/**
 * Electron main-process harness for the @nookdb/electron E2E tests.
 *
 * Usage: electron main.cjs
 * Environment:
 *   NOOK_E2E_MODE = 'happy' | 'mismatch' | 'deny'  (default: 'happy')
 */
const { app, BrowserWindow, MessageChannelMain } = require('electron');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, rmSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

async function main() {
  await app.whenReady();

  const dir = mkdtempSync(path.join(tmpdir(), 'nook-e2e-'));
  const dbPath = path.join(dir, 'app.db');

  const mode = process.env.NOOK_E2E_MODE || 'happy';

  // Dynamic import of ESM modules.
  // On Windows, absolute paths in import() must use file:// URLs.
  // We use relative paths to dist/ rather than bare specifier '@nookdb/electron/main'
  // because the package is not installed into its own node_modules (it IS the package).
  const electronPkgDir = path.resolve(__dirname, '..', '..', '..');
  const mainIndexUrl = pathToFileURL(path.join(electronPkgDir, 'dist', 'main', 'index.js')).href;
  const schemaUrl = pathToFileURL(path.resolve(__dirname, 'shared-schema.mjs')).href;
  const [{ openHost, PermissiveAuthorizer }, schemaModule] = await Promise.all([
    import(mainIndexUrl),
    import(schemaUrl),
  ]);

  const { schema, alternateSchema, deniedAuthorizer } = schemaModule;

  const authorizer = mode === 'deny' ? deniedAuthorizer() : new PermissiveAuthorizer();
  // Main ALWAYS opens with the canonical `schema`.
  // In 'mismatch' mode, the RENDERER connects with `alternateSchema` — causing descriptor mismatch.
  const host = await openHost(dbPath, { schema, authorizer });

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const rendererUrl = pathToFileURL(path.resolve(__dirname, 'renderer.html')).href;
  await win.loadURL(rendererUrl);

  // Transfer a port to the renderer
  const { port1, port2 } = new MessageChannelMain();
  const sender = {
    frameUrl: win.webContents.getURL(),
    origin: null,
    webContentsId: win.webContents.id,
  };
  host.connectPort(port1, sender);
  win.webContents.postMessage('nook:port', null, [port2]);

  app.on('window-all-closed', async () => {
    await host.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    app.quit();
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e harness failed:', err);
  app.exit(1);
});
