// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LiveQuery } from 'nookdb';
import { remoteLiveNative } from '../renderer/livenative.js';
import { RpcDispatcher } from '../shared/rpc.js';
import type { Envelope, Transport } from '../shared/wire.js';

interface MemoryTransport extends Transport {
  sent: Envelope[];
  inject(env: Envelope): void;
  triggerClose(): void;
}

function makeMemoryTransport(): MemoryTransport {
  const sent: Envelope[] = [];
  let handler: ((env: Envelope) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  return {
    sent,
    postMessage: (env) => sent.push(env),
    onmessage: (h) => {
      handler = h;
    },
    onclose: (h) => {
      closeHandler = h;
    },
    close: () => {
      closeHandler?.();
    },
    inject: (env) => handler?.(env),
    triggerClose: () => closeHandler?.(),
  };
}

describe('remoteLiveNative drives the real M3 LiveQuery (non-hollow proof)', () => {
  it('subscribe → initial → emit → dispose → cancel — end-to-end', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const live = remoteLiveNative(t, d);

    const lq = new LiveQuery<{ id: string; role: string }>(live, 'users', { role: 'admin' });

    // M3 LiveQuery sends a `subscribe` envelope through the bridge.
    await new Promise((r) => setTimeout(r, 0));
    const sub = t.sent.find(
      (e): e is Extract<Envelope, { type: 'subscribe' }> => e.type === 'subscribe',
    );
    expect(sub).toBeDefined();

    // Host replies with subscribe-ok + initial snapshot.
    t.inject({
      type: 'response',
      id: (t.sent.find((e) => e.type === 'subscribe') as { id: string }).id,
      ok: true,
      value: {
        subscriptionId: sub!.subscriptionId,
        initialJson: JSON.stringify({ ok: true, value: [{ id: '1', role: 'admin' }] }),
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(lq.value).toEqual([{ id: '1', role: 'admin' }]);

    // Host pushes a subsequent emission.
    t.inject({
      type: 'subscribe-emit',
      subscriptionId: sub!.subscriptionId,
      envelope: JSON.stringify({
        ok: true,
        value: [
          { id: '1', role: 'admin' },
          { id: '2', role: 'admin' },
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lq.value.length).toBe(2);

    // dispose() → bridge sends subscribe-cancel.
    lq.dispose();
    await new Promise((r) => setTimeout(r, 0));
    const cancel = t.sent.find((e) => e.type === 'subscribe-cancel');
    expect(cancel).toBeDefined();
  });

  it('forwards optionsJson in the subscribe envelope', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const live = remoteLiveNative(t, d);
    new LiveQuery<{ id: string }>(live, 'users', {}, JSON.stringify({ sort: { n: 'asc' }, limit: 2 }));
    await new Promise((r) => setTimeout(r, 0));
    const sub = t.sent.find(
      (e): e is Extract<Envelope, { type: 'subscribe' }> => e.type === 'subscribe',
    );
    expect(sub?.optionsJson).toBe(JSON.stringify({ sort: { n: 'asc' }, limit: 2 }));
  });

  it('terminal error envelope fails the M3 LiveQuery', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const live = remoteLiveNative(t, d);
    const lq = new LiveQuery<{ id: string }>(live, 'users', {});

    let received: unknown;
    lq.subscribe(
      () => {},
      (err) => {
        received = err;
      },
    );

    await new Promise((r) => setTimeout(r, 0));
    const sub = t.sent.find(
      (e): e is Extract<Envelope, { type: 'subscribe' }> => e.type === 'subscribe',
    )!;
    t.inject({
      type: 'response',
      id: (t.sent.find((e) => e.type === 'subscribe') as { id: string }).id,
      ok: true,
      value: {
        subscriptionId: sub.subscriptionId,
        initialJson: JSON.stringify({ ok: true, value: [] }),
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    // Host pushes an error envelope (M3 terminal-error contract).
    t.inject({
      type: 'subscribe-emit',
      subscriptionId: sub.subscriptionId,
      envelope: JSON.stringify({ ok: false, error: '[storage] recompute failed' }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toBeDefined();
  });
});
