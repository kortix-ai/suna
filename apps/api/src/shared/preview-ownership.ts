import { and, eq, ne, or } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from './db';
import { resolveAccountId } from './resolve-account';

/**
 * Preview proxy ownership check.
 *
 * Given a `previewSandboxId` (either a sandbox UUID from our table or an
 * externalId / container name like `kortix-sandbox`), return whether the
 * acting user is allowed to hit `/v1/p/:previewSandboxId/*`.
 *
 * ## Why the shape of this check matters
 *
 * Earlier revisions looked up "who owns externalId=X" globally and then
 * compared that owner's accountId to the actor's. That works fine when
 * externalIds are globally unique (cloud/Daytona, where each sandbox has
 * its own remote id), but it **breaks in local-docker mode** where every
 * user shares the same container name (`kortix-sandbox`). A single stale
 * row in the sandboxes table — e.g. from a previous test user — would
 * make the global lookup return that user's accountId, and every current
 * user would get 403 on every proxy request.
 *
 * The fix is to never ask "who owns X" — instead ask "does the actor
 * themselves own a non-pooled sandbox matching X?". That's unambiguous
 * in both modes:
 *   - Cloud: their own row matches their externalId.
 *   - Local: their own row matches `kortix-sandbox`.
 * And stale rows belonging to other accounts are invisible to this user.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CacheEntry = {
  allowed: boolean;
  expiresAt: number;
};

// Cache key is `${previewSandboxId}:${accountId}` so different accounts
// can't poison each other's ownership decisions, which was the root cause
// of the local-docker 403 storm. Key on accountId rather than userId so
// members of the same team account share the positive cache.
const ownershipCache = new Map<string, CacheEntry>();

function cacheKey(previewSandboxId: string, accountId: string): string {
  return `${previewSandboxId}:${accountId}`;
}

async function queryOwnership(
  previewSandboxId: string,
  accountId: string,
): Promise<boolean> {
  // Only compare against sandbox_id (UUID column) when the input is a valid
  // UUID, otherwise Postgres throws "invalid input syntax for type uuid".
  const idCondition = UUID_RE.test(previewSandboxId)
    ? or(
        eq(sandboxes.externalId, previewSandboxId),
        eq(sandboxes.sandboxId, previewSandboxId),
      )
    : eq(sandboxes.externalId, previewSandboxId);

  const [row] = await db
    .select({ sandboxId: sandboxes.sandboxId })
    .from(sandboxes)
    .where(
      and(
        idCondition,
        eq(sandboxes.accountId, accountId),
        ne(sandboxes.status, 'pooled'),
      ),
    )
    .limit(1);

  return !!row;
}

export async function canAccessPreviewSandbox(input: {
  previewSandboxId: string;
  userId?: string;
  accountId?: string;
}): Promise<boolean> {
  const actorAccountId =
    input.accountId ||
    (input.userId ? await resolveAccountId(input.userId) : null);
  if (!actorAccountId) return false;

  const key = cacheKey(input.previewSandboxId, actorAccountId);
  const cached = ownershipCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.allowed;
  }

  const allowed = await queryOwnership(input.previewSandboxId, actorAccountId);
  ownershipCache.set(key, {
    allowed,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return allowed;
}

export function clearPreviewOwnershipCache(): void {
  ownershipCache.clear();
}
