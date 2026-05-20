/**
 * @nookdb/electron — main-process entry point.
 *
 * `openHost` opens the underlying nookdb database and returns a `HostHandle`
 * that accepts Electron `MessagePortMain` connections from renderer processes.
 *
 * No hard import of `electron` here — `ElectronMessagePortMain` is a
 * structural interface so that the package remains loadable without Electron
 * present (tests, vitest, etc.). Electron is a peer dependency only.
 */

import { open, type SchemaShape } from 'nookdb';
import { Host, type ServerTransport } from './host.js';
import {
  type Authorizer,
  PermissiveAuthorizer,
  type BridgeOp,
  type BridgeOpKind,
  type SenderInfo,
} from '../shared/authorizer.js';
import type { Envelope } from '../shared/wire.js';

export interface OpenHostOptions<TSchema extends SchemaShape> {
  schema: TSchema;
  /** Defaults to `PermissiveAuthorizer` (free-tier). */
  authorizer?: Authorizer;
}

export interface HostHandle {
  /**
   * Accepts one Electron `MessagePortMain`. Wraps it as a `ServerTransport`
   * and registers with the Host. The renderer can then handshake on this
   * port via `connectNook` (Task 13).
   */
  connectPort(port: ElectronMessagePortMain, sender: SenderInfo): void;
  /** Closes the database and drains all ports. */
  close(): Promise<void>;
}

/**
 * Minimal structural type for the Electron `MessagePortMain` used by
 * `connectPort`. Avoids a hard runtime dep on `electron` (peer dep only)
 * while keeping the types tight.
 */
export interface ElectronMessagePortMain {
  on(event: 'message', listener: (e: { data: unknown }) => void): this;
  on(event: 'close', listener: () => void): this;
  postMessage(value: unknown): void;
  start(): void;
  close(): void;
}

function wrapPort(port: ElectronMessagePortMain): ServerTransport {
  let onMessageHandler: ((env: Envelope) => void) | null = null;
  let onCloseHandler: (() => void) | null = null;
  port.on('message', (e) => {
    onMessageHandler?.(e.data as Envelope);
  });
  port.on('close', () => {
    onCloseHandler?.();
  });
  port.start();
  return {
    postMessage: (env) => {
      port.postMessage(env);
    },
    onmessage: (h) => {
      onMessageHandler = h;
    },
    onclose: (h) => {
      onCloseHandler = h;
    },
    close: () => {
      port.close();
    },
  };
}

export async function openHost<TSchema extends SchemaShape>(
  path: string,
  options: OpenHostOptions<TSchema>,
): Promise<HostHandle> {
  const db = await open(path, { schema: options.schema });
  const authorizer = options.authorizer ?? new PermissiveAuthorizer();
  const host = new Host<TSchema>(db, options.schema, authorizer);

  return {
    connectPort(port: ElectronMessagePortMain, sender: SenderInfo): void {
      host.acceptClient(wrapPort(port), sender);
    },
    async close(): Promise<void> {
      await host.close();
      (db as unknown as { close(): void }).close();
    },
  };
}

// Re-exports for @nookdb/electron/main consumers.
export { Host };
export type { ServerTransport };
export type { SenderInfo, Authorizer, BridgeOp, BridgeOpKind };
export { PermissiveAuthorizer };
