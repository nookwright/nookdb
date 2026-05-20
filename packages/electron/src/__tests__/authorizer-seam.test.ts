// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, s, toDescriptor, type SchemaDatabase } from 'nookdb';

// ── MANDATORY: import everything from @nookdb/electron/main public path ──
// (Per extension §6 + M2-retro #2 — driving from ../shared/* would prove
// nothing, the seam must be reachable through the package's public exports.)
import {
  Host,
  PermissiveAuthorizer,
  type Authorizer,
  type BridgeOp,
  type SenderInfo,
  type ServerTransport,
} from '@nookdb/electron/main';

// The wire types + canonical helper are not part of the M4 §6 contract;
// they are test plumbing for driving a stubbed transport. Importing from
// the local shared path is fine — those are test internals.
import type { Envelope } from '../shared/wire.js';
import { canonicalize } from '../shared/canonical.js';

const schema = {
  users: s
    .collection({
      id: s.id(),
      role: s.enum(['admin', 'user'] as const),
    })
    .index('role'),
};

interface MemoryServer extends ServerTransport {
  sent: Envelope[];
  inject(env: Envelope): void;
  triggerClose(): void;
}

function makeServer(): MemoryServer {
  const sent: Envelope[] = [];
  let onMsg: ((e: Envelope) => void) | null = null;
  let onClose: (() => void) | null = null;
  return {
    sent,
    postMessage: (e) => sent.push(e),
    onmessage: (h) => {
      onMsg = h;
    },
    onclose: (h) => {
      onClose = h;
    },
    close: () => onClose?.(),
    inject: (e) => onMsg?.(e),
    triggerClose: () => onClose?.(),
  };
}

const sender: SenderInfo = { frameUrl: null, origin: null, webContentsId: 1 };
const descriptor = canonicalize(JSON.parse(toDescriptor(schema as never)));

async function withDb<R>(
  fn: (db: SchemaDatabase<typeof schema>) => Promise<R>,
): Promise<R> {
  const dir = await mkdtemp(join(tmpdir(), 'seam-'));
  const db = await open(join(dir, 'app.db'), { schema });
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Extension §M4 — pluggable authorizer seam acceptance', () => {
  it('a custom Authorizer attached through the public interface honors allow/deny', async () => {
    await withDb(async (db) => {
      let captured: { sender: SenderInfo; op: BridgeOp } | null = null;
      const custom: Authorizer = {
        authorize(s, op) {
          captured = { sender: s, op };
          // Deny insert on users; allow everything else.
          if (op.collection === 'users' && op.kind === 'insert') return false;
          return true;
        },
      };
      const host = new Host(db, schema, custom);
      const t = makeServer();
      host.acceptClient(t, sender);
      t.inject({ type: 'hello', clientId: 'c1', descriptor });
      await new Promise((r) => setTimeout(r, 10));

      // Deny path: insert on users.
      t.inject({
        type: 'query',
        id: 'q-insert',
        collection: 'users',
        op: 'insert',
        argsJson: JSON.stringify({ role: 'admin' }),
      });
      await new Promise((r) => setTimeout(r, 10));
      const denyResp = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 'q-insert',
      ) as Extract<Envelope, { type: 'response'; ok: false }> | undefined;
      expect(denyResp).toBeDefined();
      expect(denyResp!.ok).toBe(false);
      expect(denyResp!.error.kind).toBe('forbidden');

      // The custom authorizer was invoked with the correct (sender, op).
      expect(captured).not.toBeNull();
      expect(captured!.sender.webContentsId).toBe(1);
      expect(captured!.op.collection).toBe('users');
      expect(captured!.op.kind).toBe('insert');

      // Allow path: find on users.
      t.inject({
        type: 'query',
        id: 'q-find',
        collection: 'users',
        op: 'find',
        argsJson: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 10));
      const allowResp = t.sent.find(
        (e) => e.type === 'response' && (e as { id: string }).id === 'q-find',
      ) as Extract<Envelope, { type: 'response'; ok: true }> | undefined;
      expect(allowResp).toBeDefined();
      expect(allowResp!.ok).toBe(true);

      await host.close();
    });
  });

  it('PermissiveAuthorizer (free-tier default) permits every op', async () => {
    await withDb(async (db) => {
      const host = new Host(db, schema, new PermissiveAuthorizer());
      const t = makeServer();
      host.acceptClient(t, sender);
      t.inject({ type: 'hello', clientId: 'c1', descriptor });
      await new Promise((r) => setTimeout(r, 10));

      // Insert (mutates state) then 4 read ops.
      t.inject({
        type: 'query',
        id: 'q-insert',
        collection: 'users',
        op: 'insert',
        argsJson: JSON.stringify({ role: 'admin' }),
      });
      for (const op of ['find', 'findOne', 'count', 'delete'] as const) {
        t.inject({
          type: 'query',
          id: `q-${op}`,
          collection: 'users',
          op,
          argsJson: JSON.stringify({}),
        });
      }
      await new Promise((r) => setTimeout(r, 30));

      // All 5 should have ok:true responses.
      for (const id of ['q-insert', 'q-find', 'q-findOne', 'q-count', 'q-delete']) {
        const resp = t.sent.find((e) => e.type === 'response' && (e as { id: string }).id === id);
        expect(resp).toBeDefined();
        expect((resp as { ok: boolean }).ok).toBe(true);
      }
      await host.close();
    });
  });
});
