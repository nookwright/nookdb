// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, s, toDescriptor, type SchemaDatabase } from 'nookdb';
import { Host, type ServerTransport, type SenderInfo } from '../main/host.js';
import { PermissiveAuthorizer, type Authorizer } from '../shared/authorizer.js';
import { canonicalize } from '../shared/canonical.js';
import type { Envelope } from '../shared/wire.js';

const schema = {
  users: s
    .collection({
      id: s.id(),
      role: s.enum(['admin', 'user'] as const),
      n: s.number().optional(),
    })
    .index('role'),
};

interface MemoryServer extends ServerTransport {
  sent: Envelope[];
  inject(env: Envelope): void;
  triggerClose(): void;
}

function makeServerTransport(): MemoryServer {
  const sent: Envelope[] = [];
  let handler: ((env: Envelope) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  return {
    sent,
    postMessage: (env) => {
      sent.push(env);
    },
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

const sender: SenderInfo = { frameUrl: 'app://x/i.html', origin: null, webContentsId: 1 };

async function setup(authorizer?: Authorizer): Promise<{
  dir: string;
  db: SchemaDatabase<typeof schema>;
  host: Host<typeof schema>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'host-'));
  const db = await open(join(dir, 'app.db'), { schema });
  const host = new Host(db, schema, authorizer ?? new PermissiveAuthorizer());
  return {
    dir,
    db,
    host,
    cleanup: async () => {
      await host.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('Host — handshake', () => {
  it('responds hello-ack when the descriptor matches', async () => {
    const ctx = await setup();
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      const ack = t.sent.find((e) => e.type === 'hello-ack');
      expect(ack).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it('responds ok:false kind:"schema" on constraint-only descriptor diff and closes', async () => {
    const ctx = await setup();
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      // Bend the descriptor so role lacks one variant.
      const bent = JSON.parse(toDescriptor(schema as never)) as Record<string, unknown>;
      const usersCol = bent.users as { fields: { name: string; variants?: string[] }[] };
      const roleField = usersCol.fields.find((f) => f.name === 'role')!;
      roleField.variants = ['admin']; // dropped 'user'
      t.inject({ type: 'hello', clientId: 'c1', descriptor: canonicalize(bent) });
      await new Promise((r) => setTimeout(r, 10));
      const resp = t.sent.find(
        (e) => e.type === 'response' && (e as { ok: boolean }).ok === false,
      ) as Extract<Envelope, { type: 'response'; ok: false }> | undefined;
      expect(resp).toBeDefined();
      expect(resp!.error.kind).toBe('schema');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('Host — query routing', () => {
  it('executes find through the M3 typed path and responds ok:true with the rows', async () => {
    const ctx = await setup();
    try {
      await ctx.db.users.insert({ role: 'admin' });
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'query',
        id: 'q1',
        collection: 'users',
        op: 'find',
        argsJson: JSON.stringify({ role: 'admin' }),
      });
      await new Promise((r) => setTimeout(r, 30));
      const resp = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 'q1',
      ) as Extract<Envelope, { type: 'response'; ok: true }>;
      expect(resp.ok).toBe(true);
      expect(Array.isArray(resp.value)).toBe(true);
      expect((resp.value as { role: string }[])[0]?.role).toBe('admin');
    } finally {
      await ctx.cleanup();
    }
  });

  it('responds ok:false kind:"forbidden" when the authorizer denies', async () => {
    const denyInsert: Authorizer = {
      authorize: (_s, op) => op.kind !== 'insert',
    };
    const ctx = await setup(denyInsert);
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'query',
        id: 'q1',
        collection: 'users',
        op: 'insert',
        argsJson: JSON.stringify({ role: 'admin' }),
      });
      await new Promise((r) => setTimeout(r, 10));
      const resp = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 'q1',
      ) as Extract<Envelope, { type: 'response'; ok: false }>;
      expect(resp.ok).toBe(false);
      expect(resp.error.kind).toBe('forbidden');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('Host — subscription lifecycle', () => {
  it('emits initial snapshot on subscribe and forwards subsequent emissions', async () => {
    const ctx = await setup();
    try {
      await ctx.db.users.insert({ role: 'admin' });
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'subscribe',
        id: 's1',
        subscriptionId: 'sub-A',
        collection: 'users',
        filterJson: JSON.stringify({ role: 'admin' }),
      });
      await new Promise((r) => setTimeout(r, 30));
      const ack = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 's1',
      );
      expect(ack).toBeDefined();
      expect((ack as { ok: boolean }).ok).toBe(true);

      await ctx.db.users.insert({ role: 'admin' });
      await new Promise((r) => setTimeout(r, 100));
      const emits = t.sent.filter(
        (e): e is Extract<Envelope, { type: 'subscribe-emit' }> => e.type === 'subscribe-emit',
      );
      expect(emits.length).toBeGreaterThanOrEqual(1);
      const last = emits[emits.length - 1]!;
      expect(last.subscriptionId).toBe('sub-A');
      expect(last.envelope).toContain('"ok":true');
    } finally {
      await ctx.cleanup();
    }
  });

  it('applies query options (sort/limit) for find over the bridge', async () => {
    const ctx = await setup();
    try {
      for (const [n] of [[3], [1], [2]] as const) {
        await ctx.db.users.insert({ role: 'user', n });
      }
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'query',
        id: 'q1',
        collection: 'users',
        op: 'find',
        argsJson: JSON.stringify({ role: 'user' }),
        optionsJson: JSON.stringify({ sort: { n: 'asc' }, limit: 2 }),
      });
      await new Promise((r) => setTimeout(r, 20));
      const resp = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 'q1',
      ) as Extract<Envelope, { type: 'response'; ok: true }>;
      expect(resp.ok).toBe(true);
      const rows = resp.value as { n: number }[];
      expect(rows.map((r) => r.n)).toEqual([1, 2]);
    } finally {
      await ctx.cleanup();
    }
  });

  it('applies query options (sort/limit) for a live subscription over the bridge', async () => {
    const ctx = await setup();
    try {
      for (const [n] of [[3], [1], [2]] as const) {
        await ctx.db.users.insert({ role: 'user', n });
      }
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'subscribe',
        id: 's1',
        subscriptionId: 'sub-A',
        collection: 'users',
        filterJson: JSON.stringify({ role: 'user' }),
        optionsJson: JSON.stringify({ sort: { n: 'asc' }, limit: 2 }),
      });
      await new Promise((r) => setTimeout(r, 30));
      const ack = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 's1',
      ) as Extract<Envelope, { type: 'response'; ok: true }>;
      expect(ack.ok).toBe(true);
      const initial = JSON.parse((ack.value as { initialJson: string }).initialJson) as {
        ok: boolean;
        value: { n: number }[];
      };
      expect(initial.value.map((r) => r.n)).toEqual([1, 2]);
    } finally {
      await ctx.cleanup();
    }
  });

  it('drains per-port subscriptions on transport close', async () => {
    const ctx = await setup();
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'subscribe',
        id: 's1',
        subscriptionId: 'sub-A',
        collection: 'users',
        filterJson: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 30));

      // Snapshot the sent count BEFORE close — after close we expect no growth.
      const sentBeforeClose = t.sent.length;
      t.triggerClose();
      await ctx.db.users.insert({ role: 'admin' });
      await new Promise((r) => setTimeout(r, 100));
      // No new subscribe-emit envelopes after close.
      expect(t.sent.length).toBe(sentBeforeClose);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('Host — error robustness', () => {
  it('responds kind:"schema" + closes on malformed descriptor (does not strand renderer)', async () => {
    const ctx = await setup();
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({ type: 'hello', clientId: 'c1', descriptor: 'this-is-not-json' });
      await new Promise((r) => setTimeout(r, 10));
      const resp = t.sent.find(
        (e) => e.type === 'response' && (e as { ok: boolean }).ok === false,
      ) as Extract<Envelope, { type: 'response'; ok: false }> | undefined;
      expect(resp).toBeDefined();
      expect(resp!.error.kind).toBe('schema');
    } finally {
      await ctx.cleanup();
    }
  });

  it('returns a typed error response when the Authorizer throws (does not strand renderer)', async () => {
    const throwing: Authorizer = {
      authorize: () => {
        throw new Error('[storage] permission lookup failed');
      },
    };
    const ctx = await setup(throwing);
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      t.inject({
        type: 'hello',
        clientId: 'c1',
        descriptor: canonicalize(JSON.parse(toDescriptor(schema as never))),
      });
      await new Promise((r) => setTimeout(r, 10));
      t.inject({
        type: 'query',
        id: 'qX',
        collection: 'users',
        op: 'find',
        argsJson: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 10));
      const resp = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 'qX',
      ) as Extract<Envelope, { type: 'response'; ok: false }> | undefined;
      expect(resp).toBeDefined();
      expect(resp!.ok).toBe(false);
      // Whether kind is 'storage' (from the message prefix mapping) or another
      // is acceptable; the contract is "renderer gets a response, not silence".
    } finally {
      await ctx.cleanup();
    }
  });

  it('ignores a duplicate hello on the same port (does not send a second hello-ack)', async () => {
    const ctx = await setup();
    try {
      const t = makeServerTransport();
      ctx.host.acceptClient(t, sender);
      const descriptor = canonicalize(JSON.parse(toDescriptor(schema as never)));
      t.inject({ type: 'hello', clientId: 'c1', descriptor });
      await new Promise((r) => setTimeout(r, 10));
      const firstAcks = t.sent.filter((e) => e.type === 'hello-ack');
      expect(firstAcks.length).toBe(1);

      t.inject({ type: 'hello', clientId: 'c1-again', descriptor });
      await new Promise((r) => setTimeout(r, 10));
      const totalAcks = t.sent.filter((e) => e.type === 'hello-ack');
      expect(totalAcks.length).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });
});
