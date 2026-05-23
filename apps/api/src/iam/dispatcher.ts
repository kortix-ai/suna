// Engine dispatcher. Reads accounts.iam_v2_enabled and routes
// authorize / assertAuthorized / listAccessibleResources to the V1 or
// V2 engine accordingly. Public API for the rest of the codebase — both
// engines stay independent behind this seam.
//
// Flag reads are memoised behind a tiny TTL cache so the hot path
// doesn't pay an extra SELECT per authorize() call. Flag flips are
// rare and propagate within the TTL window (a few seconds), which is
// acceptable for an opt-in rollout flag.

import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { accounts } from '@kortix/db';
import { db } from '../shared/db';
import {
  authorize as authorizeV1,
  listAccessibleResources as listAccessibleResourcesV1,
  type AccessibleResources,
  type AuthorizeResult,
  type AuthorizeTarget,
  type RequestContext,
} from './engine';
import type { ResourceType } from './actions';
import { authorizeV2, listAccessibleProjectsV2 } from './engine-v2';

// ─── Flag cache ────────────────────────────────────────────────────────────

const FLAG_TTL_MS = 30_000;
const FLAG_MAX_ENTRIES = 256;

type FlagCacheEntry = { v2: boolean; expiresAt: number };
const flagCache = new Map<string, FlagCacheEntry>();

async function isV2Enabled(accountId: string): Promise<boolean> {
  const now = Date.now();
  const cached = flagCache.get(accountId);
  if (cached && cached.expiresAt > now) return cached.v2;

  const [row] = await db
    .select({ iamV2Enabled: accounts.iamV2Enabled })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  const v2 = !!row?.iamV2Enabled;

  if (flagCache.size >= FLAG_MAX_ENTRIES) {
    // Drop the oldest entry. Map preserves insertion order, so the
    // first key is the LRU-ish victim.
    const firstKey = flagCache.keys().next().value;
    if (firstKey !== undefined) flagCache.delete(firstKey);
  }
  flagCache.set(accountId, { v2, expiresAt: now + FLAG_TTL_MS });
  return v2;
}

/** Test-only: drop any cached flag for `accountId`. Use after flipping
 *  `accounts.iam_v2_enabled` so the next authorize() sees the new value
 *  immediately rather than waiting for the TTL. */
export function invalidateIamV2Flag(accountId?: string): void {
  if (accountId) flagCache.delete(accountId);
  else flagCache.clear();
}

// ─── Public surface (same signatures as V1) ────────────────────────────────

export async function authorize(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AuthorizeResult> {
  if (await isV2Enabled(accountId)) {
    return authorizeV2(userId, accountId, action, target, actingTokenId, requestCtx);
  }
  return authorizeV1(userId, accountId, action, target, actingTokenId, requestCtx);
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
  if (!(await isV2Enabled(accountId))) {
    return listAccessibleResourcesV1(
      userId,
      accountId,
      action,
      resourceType,
      actingTokenId,
      requestCtx,
    );
  }

  // V2 only supports project listings — sandboxes/triggers/channels are
  // reached via their owning project, never listed standalone. Asking
  // for a non-project resourceType under V2 returns nothing.
  if (resourceType !== 'project') return { mode: 'none' };

  const v = await listAccessibleProjectsV2(
    userId,
    accountId,
    action,
    actingTokenId,
    requestCtx,
  );
  return v;
}
