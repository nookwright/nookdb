import type { BridgeOp, BridgeOpKind } from './wire.js';

export type { BridgeOp, BridgeOpKind };

/**
 * Identifying information about the renderer making a bridge request.
 *
 * `frameUrl` is the renderer's `window.location.href` at preload time
 * (snapshotted once when the bridge port is exposed). `origin` is the
 * parsed origin, or `null` for non-`http(s)` URLs (e.g. `file://` in
 * dev). `webContentsId` is Electron's identifier for the source
 * WebContents.
 */
export interface SenderInfo {
  frameUrl: string | null;
  origin: string | null;
  webContentsId: number;
}

/**
 * Pluggable per-op authorizer for the @nookdb/electron bridge
 * (PRD §8.6; extension seam — spec §6 / extension §6).
 *
 * Host invokes `await Promise.resolve(authorizer.authorize(sender, op))`
 * before executing every `query` and `subscribe` envelope. Deny → the
 * renderer receives `{ ok:false, error: { kind:'forbidden', ... } }`.
 * `subscribe-cancel` is NOT authorized (the renderer is cancelling its
 * own subscription; port-close cleanup is also unconditional).
 *
 * The default is `PermissiveAuthorizer`. An external integrator
 * may ship a richer multi-tenant authorizer; no Pro code exists in
 * MIT core pre-1.0 — only this stable interface.
 */
export interface Authorizer {
  authorize(sender: SenderInfo, op: BridgeOp): boolean | Promise<boolean>;
}

/** Free-tier default: permits every op. */
export class PermissiveAuthorizer implements Authorizer {
  authorize(): boolean {
    return true;
  }
}
