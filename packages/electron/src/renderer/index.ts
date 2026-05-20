import { toDescriptor, type SchemaDatabase, type SchemaShape } from 'nookdb';
import { canonicalize } from '../shared/canonical.js';
import { makeRemoteDatabase } from './proxy.js';
import { RpcDispatcher } from '../shared/rpc.js';
import { mapBridgeError } from '../shared/errors.js';
import type { Envelope, Transport } from '../shared/wire.js';

export { NookForbiddenError } from '../shared/errors.js';
export type { Transport } from '../shared/wire.js';

/**
 * Default Electron `MessagePort` transport. Waits for the preload's
 * `window.postMessage('nook:port', '*', [port])` and wraps the port.
 *
 * `MessagePort` exposes neither a `close` event nor a way to detect
 * remote-end close — so `onclose` here is fired only on explicit
 * `transport.close()`. Renderers detect main-side close indirectly via
 * RPC promises that hang or via Electron's webContents lifecycle.
 */
function defaultElectronTransport(): Promise<Transport> {
  return new Promise<Transport>((resolve) => {
    const handler = (event: MessageEvent): void => {
      if (event.data !== 'nook:port') return;
      const port = event.ports[0];
      if (port === undefined) return;
      window.removeEventListener('message', handler);

      let onMessageHandler: ((env: Envelope) => void) | null = null;
      let onCloseHandler: (() => void) | null = null;
      port.onmessage = (e): void => {
        onMessageHandler?.(e.data as Envelope);
      };
      port.start();

      resolve({
        postMessage: (env) => port.postMessage(env),
        onmessage: (h) => {
          onMessageHandler = h;
        },
        onclose: (h) => {
          onCloseHandler = h;
        },
        close: () => {
          port.close();
          onCloseHandler?.();
        },
      });
    };
    window.addEventListener('message', handler);
  });
}

export interface ConnectNookOptions<TSchema extends SchemaShape> {
  schema: TSchema;
  /** Defaults to the Electron `MessagePort` transport. */
  transport?: Transport;
}

let nextClientId = 1;

/**
 * Renderer-side entry point. Picks up the bridge port (default: Electron
 * `MessagePort`) or accepts an injected `Transport` (v2 Tauri / tests),
 * runs the handshake, and returns a typed `SchemaDatabase<TSchema>` handle
 * with an additional `disconnect()` method that closes the transport.
 *
 * On schema-descriptor mismatch, the host responds with `kind:'schema'`
 * which `RpcDispatcher.expect` routes through `mapBridgeError` into a
 * `NookSchemaError` — `connectNook` propagates it (no swallowing).
 */
export async function connectNook<TSchema extends SchemaShape>(
  options: ConnectNookOptions<TSchema>,
): Promise<SchemaDatabase<TSchema> & { disconnect(): void }> {
  const transport = options.transport ?? (await defaultElectronTransport());
  const dispatcher = new RpcDispatcher(transport);
  const descriptor = canonicalize(JSON.parse(toDescriptor(options.schema as never)));
  const clientId = `c${nextClientId++}`;

  const helloEnv: Envelope = { type: 'hello', clientId, descriptor };

  try {
    await dispatcher.expect(helloEnv, 'hello-ack');
  } catch (err) {
    transport.close();
    // If RpcDispatcher already wrapped this into a typed NookError via
    // mapBridgeError, re-throw as-is (it starts with '[kind]').
    if (err instanceof Error && err.message.startsWith('[')) {
      throw err;
    }
    // Otherwise wrap as a generic schema error so callers always see typed.
    throw mapBridgeError({
      kind: 'schema',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return makeRemoteDatabase(transport, dispatcher, options.schema);
}
