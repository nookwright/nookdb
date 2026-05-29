import type { LiveNative } from 'nookdb';
import type { RpcDispatcher } from '../shared/rpc.js';
import { mapBridgeError } from '../shared/errors.js';
import type { Envelope, Transport } from '../shared/wire.js';

/**
 * Implements `nookdb.LiveNative` over the bridge wire so the M3
 * `LiveQuery<T>` class works unchanged cross-process.
 *
 * - `live(coll, filterJson, onEmit)` sends a `subscribe` envelope and
 *   resolves with the renderer-chosen `subscriptionId` + the host's
 *   initial snapshot envelope (a string carrying the M3 emit-envelope
 *   verbatim).
 * - `subscribe-emit` envelopes route here via `RpcDispatcher.onUnhandled`,
 *   matched by `subscriptionId` to the right `onEmit`.
 * - `liveCancel(subscriptionId)` posts a one-way `subscribe-cancel` and
 *   removes the local sink entry.
 *
 * `_transport` is accepted but not directly subscribed to — routing goes
 * through the dispatcher's `onUnhandled` hook (single `transport.onmessage`
 * handler is reserved for the dispatcher itself).
 */
export function remoteLiveNative(
  _transport: Transport,
  dispatcher: RpcDispatcher,
): LiveNative {
  const sinks = new Map<string, (envelopeJson: string) => void>();

  dispatcher.onUnhandled((env: Envelope) => {
    if (env.type === 'subscribe-emit') {
      sinks.get(env.subscriptionId)?.(env.envelope);
    }
  });

  let nextSubId = 1;

  return {
    // `optionsJson` (sort/limit/offset) is accepted to match nookdb's
    // updated `LiveNative.live` signature, but is NOT forwarded over the
    // bridge yet — the `subscribe` wire envelope and Host carry no query
    // options. Cross-process live() sort/limit is a follow-up; today the
    // renderer proxy never passes options, so this is always undefined.
    async live(collection, filterJson, _optionsJson, onEmit) {
      const subscriptionId = `sub-${nextSubId++}`;
      sinks.set(subscriptionId, onEmit);
      const reply = await dispatcher.send({
        type: 'subscribe',
        id: '', // dispatcher replaces
        subscriptionId,
        collection,
        filterJson,
      });
      if (!reply.ok) {
        sinks.delete(subscriptionId);
        throw mapBridgeError(reply.error);
      }
      // Host returns { subscriptionId, initialJson }.
      const v = reply.value as { subscriptionId: string; initialJson: string };
      return { subscriptionId: v.subscriptionId, initialJson: v.initialJson };
    },
    liveCancel(subscriptionId) {
      sinks.delete(subscriptionId);
      dispatcher.postCancel({ type: 'subscribe-cancel', subscriptionId });
    },
  };
}
