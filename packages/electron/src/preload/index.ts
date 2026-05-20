/**
 * Preload-side bridge installer.
 *
 * Called once from the Electron preload script. Listens for a
 * main-process `nook:port` IPC message that transfers a
 * `MessagePortMain` and rebroadcasts it as a `window.postMessage` event
 * the renderer picks up via `window.addEventListener('message', ...)`.
 *
 * Usage (preload.ts):
 *
 *     import { exposeNookBridge } from '@nookdb/electron/preload';
 *     exposeNookBridge();
 *
 * The main-side application code is expected to send the port via:
 *
 *     const { port1, port2 } = new MessageChannelMain();
 *     hostHandle.connectPort(port1, { frameUrl, origin, webContentsId });
 *     webContents.postMessage('nook:port', null, [port2]);
 */

interface IpcRendererLite {
  on(
    channel: 'nook:port',
    listener: (event: { ports: MessagePort[] }) => void,
  ): void;
}

// Electron's preload context exposes `ipcRenderer` from `electron`.
// Avoid a hard import so the package doesn't drag `electron` into
// bundling outside an Electron context.
// `declare var` is a TypeScript ambient declaration (type-only); ESLint's
// no-var rule does not apply to ambient `declare var` statements.
declare var ipcRenderer: IpcRendererLite | undefined;

export function exposeNookBridge(): void {
  // Access via globalThis to satisfy typed access without importing electron.
  const ipc =
    typeof ipcRenderer !== 'undefined' ? ipcRenderer : undefined;
  if (ipc === undefined) {
    throw new Error(
      '[invalid_arg] exposeNookBridge: ipcRenderer is not available — call from an Electron preload script',
    );
  }
  ipc.on('nook:port', (event) => {
    const port = event.ports[0];
    if (port === undefined) return;
    // Re-broadcast inside the renderer; `connectNook` picks this up.
    window.postMessage('nook:port', '*', [port]);
  });
}
