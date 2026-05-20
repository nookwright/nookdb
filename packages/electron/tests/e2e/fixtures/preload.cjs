'use strict';
/**
 * Preload script for the @nookdb/electron E2E harness.
 *
 * Uses contextIsolation:true + contextBridge.exposeInMainWorld.
 * Imports the real @nookdb/electron/dist/renderer/index.js — which now works
 * because nookdb's native binding load is lazy (only triggered by open(), not
 * at import time). This proves the production scenario end-to-end.
 *
 * MessagePort is received via ipcRenderer and wrapped into a Transport before
 * being passed to connectNook({ schema, transport }) — bypasses the default
 * window.addEventListener('message') path in defaultElectronTransport.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ipcRenderer, contextBridge } = require('electron');

const electronPkgDir = path.resolve(__dirname, '..', '..', '..');

function u(absPath) {
  return pathToFileURL(absPath).href;
}

// ── Port relay ──────────────────────────────────────────────────────────────
// The port arrives from main.cjs after win.loadURL resolves.
// Store it until connectNook() requests it.
let portResolve = null;
let pendingPort = null;

ipcRenderer.on('nook:port', (event) => {
  const port = event.ports[0];
  if (!port) return;
  if (portResolve !== null) {
    portResolve(port);
    portResolve = null;
  } else {
    pendingPort = port;
  }
});

function getPort() {
  if (pendingPort !== null) {
    const p = pendingPort;
    pendingPort = null;
    return Promise.resolve(p);
  }
  return new Promise((resolve) => { portResolve = resolve; });
}

// ── Build a Transport from a MessagePort ────────────────────────────────────
function makeTransport(port) {
  let onMessageHandler = null;
  let onCloseHandler = null;
  port.onmessage = (e) => { onMessageHandler?.(e.data); };
  port.start();
  return {
    postMessage: (env) => port.postMessage(env),
    onmessage: (h) => { onMessageHandler = h; },
    onclose: (h) => { onCloseHandler = h; },
    close: () => { port.close(); onCloseHandler?.(); },
  };
}

// ── Setup promise ───────────────────────────────────────────────────────────
// Resolved with { connectNook, usedSchema } once ESM imports complete.
// All bridge API functions await this before executing.
let setupResolve;
let setupReject;
const setupComplete = new Promise((res, rej) => {
  setupResolve = res;
  setupReject = rej;
});

// ── Expose API synchronously (methods await setupComplete internally) ────────
let _db = null;
let _snaps = [];
let _lq = null;
let _off = null;

contextBridge.exposeInMainWorld('__nook', {
  async connect() {
    const { connectNook, usedSchema } = await setupComplete;
    try {
      const port = await getPort();
      _db = await connectNook({ schema: usedSchema, transport: makeTransport(port) });
      return { ok: true };
    } catch (err) {
      return { ok: false, name: err?.name, message: err?.message };
    }
  },
  async insertAdmin(id) {
    await setupComplete;
    try {
      await _db.users.insert({ id, role: 'admin' });
      return { ok: true };
    } catch (err) {
      // contextBridge loses custom error 'name' — return it as data
      return { ok: false, name: err?.name ?? 'Error', message: err?.message };
    }
  },
  async findAdmins() {
    await setupComplete;
    return await _db.users.find({ role: 'admin' });
  },
  async liveStart() {
    await setupComplete;
    _snaps = [];
    _lq = _db.users.live({ role: 'admin' });
    _off = _lq.subscribe((v) => { _snaps.push(v.length); });
  },
  async liveSnaps() {
    await setupComplete;
    return [..._snaps]; // return a copy for serialization
  },
  async liveDispose() {
    await setupComplete;
    if (_off) { _off(); _off = null; }
    if (_lq) { _lq.dispose(); _lq = null; }
  },
  async disconnect() {
    await setupComplete;
    if (_db) { _db.disconnect?.(); _db = null; }
  },
  // setupError is null on success, error message string on failure
  async getSetupError() {
    try { await setupComplete; return null; }
    catch (err) { return err?.message ?? String(err); }
  },
});

// ── Async setup ─────────────────────────────────────────────────────────────
// Imports the real @nookdb/electron/dist/renderer/index.js connectNook.
// This works because nookdb's top-level binding load is now lazy:
// importing nookdb sub-modules no longer triggers .node loading.
async function setup() {
  const { connectNook } = await import(
    u(path.join(electronPkgDir, 'dist', 'renderer', 'index.js'))
  );
  const { schema, alternateSchema } = await import(
    u(path.resolve(__dirname, 'shared-schema.mjs'))
  );
  const mode = process.env.NOOK_E2E_MODE || 'happy';
  const usedSchema = mode === 'mismatch' ? alternateSchema : schema;
  setupResolve({ connectNook, usedSchema });
}

setup().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[preload] setup failed:', err);
  setupReject(err);
});
