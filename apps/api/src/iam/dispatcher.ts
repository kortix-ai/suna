// Engine entry points for the rest of the codebase. The dispatcher used
// to pick between V1 (policy-based) and V2 (role-based) engines based on
// the per-account iam_v2_enabled flag. Now V2 is the only path.
//
// Kept as a thin wrapper because:
//   1. Route handlers + the cache helper already import from here.
//   2. assertAuthorized turns "denied" into an HTTPException so V2
//      doesn't need to know about Hono.
//   3. iam/index.ts re-exports these names, and the route layer pins to
//      that import path.
//
// invalidateIamV2Flag is now a no-op kept for binary compatibility with
// the migration script; it can be removed in the next cleanup pass.

import { HTTPException } from 'hono/http-exception';
import type {
  AccessibleResources,
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './engine';
import type { ResourceType } from './actions';
import { authorizeV2, listAccessibleProjectsV2 } from './engine-v2';

/** Kept as a no-op so the migration script's import doesn't break.
 *  Safe to delete once we remove that call site. */
export function invalidateIamV2Flag(_accountId?: string): void {
  // no-op
}

export async function authorize(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AuthorizeResult> {
  return authorizeV2(userId, accountId, action, target, actingTokenId, requestCtx);
}

export async function assertAuthorized(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx?: RequestContext,
): Promise<void> {
  const result = await authorize(userId, accountId, action, target, actingTokenId, requestCtx);
  if (!result.allowed) {
    throw new HTTPException(403, {
      message: `forbidden: ${action} (${result.reason ?? 'denied'})`,
    });
  }
}

export async function listAccessibleResources(
  userId: string,
  accountId: string,
  action: string,
  resourceType: ResourceType,
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AccessibleResources> {
  // V2 only supports project listings — sandboxes/triggers/channels are
  // reached via their owning project, never listed standalone.
  if (resourceType !== 'project') return { mode: 'none' };

  return listAccessibleProjectsV2(
    userId,
    accountId,
    action,
    actingTokenId,
    requestCtx,
  );
}
