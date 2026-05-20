import { describe, expect, it } from 'vitest';
import {
  PermissiveAuthorizer,
  type Authorizer,
  type BridgeOp,
  type SenderInfo,
} from '../shared/authorizer.js';

const fakeSender: SenderInfo = {
  frameUrl: 'app://renderer/index.html',
  origin: null,
  webContentsId: 1,
};

describe('PermissiveAuthorizer (free-tier default)', () => {
  it('permits every op kind on every collection', async () => {
    const a = new PermissiveAuthorizer();
    for (const kind of ['insert', 'find', 'findOne', 'count', 'delete', 'subscribe'] as const) {
      const op: BridgeOp = { collection: 'users', kind };
      expect(await Promise.resolve(a.authorize(fakeSender, op))).toBe(true);
    }
  });
});

describe('Authorizer interface', () => {
  it('is implementable with a synchronous decision', () => {
    class Deny implements Authorizer {
      authorize(): boolean {
        return false;
      }
    }
    expect(new Deny().authorize(fakeSender, { collection: 'x', kind: 'find' })).toBe(false);
  });

  it('is implementable with an async decision', async () => {
    class Async implements Authorizer {
      async authorize(_s: SenderInfo, op: BridgeOp): Promise<boolean> {
        return await Promise.resolve(op.collection === 'public');
      }
    }
    const a = new Async();
    expect(await a.authorize(fakeSender, { collection: 'public', kind: 'find' })).toBe(true);
    expect(await a.authorize(fakeSender, { collection: 'private', kind: 'find' })).toBe(false);
  });
});
