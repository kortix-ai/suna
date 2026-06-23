/**
 * IAM cache revoke-invalidation registry.
 *
 * The authz hot path memoizes principal lookups for ~15s (see ttl-memo.ts).
 * Positive-only caching makes a fresh GRANT visible immediately, but a REVOKE
 * (role removed/demoted, group membership/grant dropped) used to linger for up
 * to one TTL window across replicas — so no gate was a real security boundary.
 *
 * Every authz memo whose cache key begins with `${userId}|` registers itself
 * here; a mutation that changes what a user can do then calls
 * `invalidateIamCacheForUser(userId)` and every registered memo drops that
 * user's entries synchronously. (loadTokenProjectBinding is keyed by tokenId,
 * not userId — token bindings are immutable after mint, so it isn't registered.)
 *
 * Registration is push-based (memos call register at module load) to avoid an
 * import cycle: this module must not import the engine/access modules that own
 * the memos. Process-local only — each API replica busts its own cache; that's
 * correct because each replica owns an independent in-memory Map.
 */

import { eq } from 'drizzle-orm';
import { accountGroupMembers } from '@kortix/db';
import { db } from '../shared/db';

interface PrincipalScopedMemo {
  invalidateByPrefix: (prefix: string) => void;
}

const principalScopedMemos: PrincipalScopedMemo[] = [];

/** A memo keyed `${userId}|…` registers so it can be busted per principal. */
export function registerPrincipalScopedMemo(memo: PrincipalScopedMemo): void {
  principalScopedMemos.push(memo);
}

/** Drop every cached authz entry for one user across all registered memos. */
export function invalidateIamCacheForUser(userId: string | null | undefined): void {
  if (!userId) return;
  const prefix = `${userId}|`;
  for (const memo of principalScopedMemos) memo.invalidateByPrefix(prefix);
}

/** Bulk variant — e.g. busting every member of a group whose grant changed. */
export function invalidateIamCacheForUsers(userIds: Iterable<string | null | undefined>): void {
  for (const userId of userIds) invalidateIamCacheForUser(userId);
}

/**
 * A group's project grant changed — bust every member, since each member's
 * effective project role is derived from the group's grants. Best-effort:
 * a lookup failure leaves the ~15s TTL as the (pre-existing) fallback, so a
 * grant mutation never fails on cache housekeeping.
 */
export async function invalidateIamCacheForGroup(groupId: string | null | undefined): Promise<void> {
  if (!groupId) return;
  try {
    const rows = await db
      .select({ userId: accountGroupMembers.userId })
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.groupId, groupId));
    invalidateIamCacheForUsers(rows.map((r) => r.userId));
  } catch (err) {
    console.warn('[iam-cache] group invalidation lookup failed', { groupId, err: (err as Error)?.message });
  }
}
