import { describe, expect, it } from 'vitest';
import { rpc, rpcExpect, RpcDispatcher } from '../shared/rpc.js';
import type { Envelope, Transport } from '../shared/wire.js';
import { NookSchemaError, NookError } from 'nookdb';

/**
 * In-memory transport for testing. Single-handler `onmessage`/`onclose`
 * (matches real MessagePort) — multi-handler routing is the dispatcher's
 * job via onUnhandled.
 */
function makeMemoryTransport(): Transport & {
  sent: Envelope[];
  inject(env: Envelope): void;
  triggerClose(): void;
} {
  const sent: Envelope[] = [];
  let handler: ((env: Envelope) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  return {
    sent,
    postMessage(env) {
      sent.push(env);
    },
    onmessage(h) {
      handler = h;
    },
    onclose(h) {
      closeHandler = h;
    },
    close() {
      closeHandler?.();
    },
    inject(env) {
      handler?.(env);
    },
    triggerClose() {
      closeHandler?.();
    },
  };
}

describe('RpcDispatcher.send — concurrent id correlation', () => {
  it('correlates responses to senders by id, even out of order', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const p1 = d.send({
      type: 'query',
      id: '', // dispatcher fills
      collection: 'c',
      op: 'find',
      argsJson: '{}',
    });
    const p2 = d.send({
      type: 'query',
      id: '',
      collection: 'c',
      op: 'count',
      argsJson: '{}',
    });
    const sentIds = t.sent.map((e) => (e.type === 'query' ? e.id : ''));
    expect(new Set(sentIds).size).toBe(2);

    // Resolve out of order.
    t.inject({ type: 'response', id: sentIds[1]!, ok: true, value: 42 });
    t.inject({ type: 'response', id: sentIds[0]!, ok: true, value: ['a', 'b'] });

    expect(await p1).toEqual({ ok: true, value: ['a', 'b'] });
    expect(await p2).toEqual({ ok: true, value: 42 });
  });
});

describe('RpcDispatcher — close rejects pending', () => {
  it('rejects in-flight send() promises on transport close', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const p = d.send({
      type: 'query',
      id: '',
      collection: 'c',
      op: 'find',
      argsJson: '{}',
    });
    t.triggerClose();
    await expect(p).rejects.toThrow(/transport closed/);
  });
});

describe('rpc() helper', () => {
  it('unwraps ok:true to value and throws typed NookError on ok:false', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);

    const okPromise = rpc<number>(d, 'count', 'c', '{}');
    const sentId1 = (t.sent[0] as Extract<Envelope, { type: 'query' }>).id;
    t.inject({ type: 'response', id: sentId1, ok: true, value: 7 });
    expect(await okPromise).toBe(7);

    const errPromise = rpc<number>(d, 'find', 'c', '{}');
    const sentId2 = (t.sent[1] as Extract<Envelope, { type: 'query' }>).id;
    t.inject({
      type: 'response',
      id: sentId2,
      ok: false,
      error: { kind: 'invalid_arg', message: 'bad filter' },
    });
    await expect(errPromise).rejects.toBeInstanceOf(NookError);
  });
});

describe('rpcExpect (handshake)', () => {
  it('resolves on the expected envelope type (hello-ack)', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const p = rpcExpect(d, { type: 'hello', clientId: 'c1', descriptor: '{}' }, 'hello-ack');
    t.inject({ type: 'hello-ack', clientId: 'c1', sessionId: 's1' });
    const env = await p;
    expect(env.type).toBe('hello-ack');
  });

  it('throws NookSchemaError when host responds ok:false kind:"schema" during a pending hello', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const p = rpcExpect(d, { type: 'hello', clientId: 'c1', descriptor: '{}' }, 'hello-ack');
    // Host sends a response envelope (NOT hello-ack) — id is the literal 'hello'.
    t.inject({
      type: 'response',
      id: 'hello',
      ok: false,
      error: { kind: 'schema', message: 'descriptor mismatch' },
    });
    await expect(p).rejects.toBeInstanceOf(NookSchemaError);
  });
});

describe('RpcDispatcher.onUnhandled (carry-forward for Task 10)', () => {
  it('fires for envelopes the dispatcher does not consume (e.g. subscribe-emit)', () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const observed: Envelope[] = [];
    d.onUnhandled((env) => observed.push(env));
    t.inject({
      type: 'subscribe-emit',
      subscriptionId: 'sub-A',
      envelope: '{"ok":true,"value":[]}',
    });
    expect(observed.length).toBe(1);
    expect(observed[0]?.type).toBe('subscribe-emit');
  });

  it('does NOT fire for response envelopes (those go to send() callers)', async () => {
    const t = makeMemoryTransport();
    const d = new RpcDispatcher(t);
    const observed: Envelope[] = [];
    d.onUnhandled((env) => observed.push(env));
    const p = d.send({
      type: 'query',
      id: '',
      collection: 'c',
      op: 'find',
      argsJson: '{}',
    });
    const sentId = (t.sent[0] as Extract<Envelope, { type: 'query' }>).id;
    t.inject({ type: 'response', id: sentId, ok: true, value: 1 });
    await p;
    expect(observed.length).toBe(0);
  });
});
