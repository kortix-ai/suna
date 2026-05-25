// Public engine entry points used everywhere outside the iam/ module.
// V2 is the only authorization path — the V1 policy engine and its
// flag-based dispatcher were retired in PR5. The wrapper survives
// because:
//   - assertAuthorized turns "denied" into an HTTPException so V2
//     itself doesn't need to know about Hono.
//   - listAccessibleResources collapses non-project resource types
//     to mode:'none' (V2 only lists projects).
//   - The route layer + cache helper + iam/index.ts all pin their
//     imports here; consolidating preserves that import path.

import { HTTPException } from 'hono/http-exception';
import type {
  AccessibleResources,
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './engine';
import type { ResourceType } from './actions';
import { authorizeV2, listAccessibleProjectsV2 } from './engine-v2';

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
