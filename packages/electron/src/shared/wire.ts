/**
 * Shared wire vocabulary for the @nookdb/electron multi-process bridge.
 *
 * Two layers of envelope are deliberate (see spec §1):
 *   1. The bridge `Envelope` (the union below) is the transport-agnostic
 *      message format carried over `MessagePort`/structured-clone.
 *   2. `subscribe-emit.envelope` is a string carrying the **M3
 *      emit-envelope verbatim** (`{"ok":true,"value":[…]}` |
 *      `{"ok":false,"error":"[kind] message"}`). The bridge does NOT
 *      re-parse it; the renderer's `LiveNative` impl passes it straight
 *      into `LiveQuery.#onEnvelope`. Single emit codec end-to-end.
 *
 * `Transport` is the v2 Tauri kanca: v1 default is a
 * `MessagePortTransport` over Electron's MessagePort/MessagePortMain;
 * v2 Tauri adapter implements the same interface — bridge code is
 * transport-agnostic. `onclose` is added beyond PRD §8.3 so both sides
 * can react to disconnect without peeking at native port APIs.
 */

export type QueryOp = 'insert' | 'find' | 'findOne' | 'count' | 'delete';

export type BridgeOpKind = QueryOp | 'subscribe';

export interface BridgeOp {
  collection: string;
  kind: BridgeOpKind;
  /** Queries: filter; insert: doc; subscribe: { filter }. */
  args?: unknown;
}

/** The `[kind] message` convention mirrors NAPI's error mapping. */
export interface SerializedError {
  kind: string;
  message: string;
}

export type Envelope =
  | { type: 'hello'; clientId: string; descriptor: string }
  | { type: 'hello-ack'; clientId: string; sessionId: string }
  | {
      type: 'query';
      id: string;
      collection: string;
      op: QueryOp;
      argsJson: string;
      optionsJson?: string | undefined;
    }
  | {
      type: 'subscribe';
      id: string;
      subscriptionId: string;
      collection: string;
      filterJson: string;
      optionsJson?: string | undefined;
    }
  | { type: 'subscribe-cancel'; subscriptionId: string }
  | { type: 'response'; id: string; ok: true; value: unknown }
  | { type: 'response'; id: string; ok: false; error: SerializedError }
  | {
      type: 'subscribe-emit';
      subscriptionId: string;
      envelope: string;
    };

export interface Transport {
  postMessage(env: Envelope): void;
  onmessage(handler: (env: Envelope) => void): void;
  onclose(handler: () => void): void;
  close(): void;
}
