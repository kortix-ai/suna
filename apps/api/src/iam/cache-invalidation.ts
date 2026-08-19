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
import { accountGroupMembers, accountMembers, roleAssignments } from '@kortix/db';
import { db } from '../shared/db';

interface PrincipalScopedMemo {
  invalidateByPrefix: (prefix: string) => void;
}

const principalScopedMemos: PrincipalScopedMemo[] = [];

/** A memo keyed `${userId}|…` registers so it can be busted per principal. */
export function registerPrincipalScopedMemo(memo: PrincipalScopedMemo): void {
  principalScopedMemos.push(memo);
}

// ── Project-scoped memos (keyed `${projectId}|…`) ──────────────────────────
// The per-resource grant memo (resource-grants.ts) is keyed by project, not
// principal: a resource-grant change affects every principal of the project at
// once, so it busts the whole project entry rather than fanning out to members.
const projectScopedMemos: PrincipalScopedMemo[] = [];

/** A memo keyed `${projectId}|…` registers so it can be busted per project. */
export function registerProjectScopedMemo(memo: PrincipalScopedMemo): void {
  projectScopedMemos.push(memo);
}

/** Drop every cached entry for one project — e.g. after a resource-grant
 *  mutation. Process-local (same contract as the principal-scoped busts). */
export function invalidateIamCacheForProjectResources(projectId: string | null | undefined): void {
  if (!projectId) return;
  const prefix = `${projectId}|`;
  for (const memo of projectScopedMemos) memo.invalidateByPrefix(prefix);
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

/**
 * An account-wide setting the resolved actor caches (e.g. `accounts.mfaRequired`)
 * changed — bust every member of the account, since resolveActorV2 memoizes that
 * setting per `${userId}|${accountId}` alongside the member's role. Best-effort,
 * same contract as invalidateIamCacheForGroup: a lookup failure leaves the
 * pre-existing TTL fallback rather than failing the mutation.
 */
export async function invalidateIamCacheForAccount(accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  try {
    const rows = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(eq(accountMembers.accountId, accountId));
    invalidateIamCacheForUsers(rows.map((r) => r.userId));
  } catch (err) {
    console.warn('[iam-cache] account invalidation lookup failed', { accountId, err: (err as Error)?.message });
  }
}

/**
 * A custom role's action set changed — bust every principal ASSIGNED it. Group
 * principals fan out to their members; a user and a service account are each
 * their own principal id. Best-effort. Call after editing a role's permissions
 * or deleting a role.
 *
 * Reads `role_assignments`, not `iam_policies`: a binding written through
 * `assignRole()` has no legacy row, so the old lookup would silently miss it and
 * the holder would keep the stale action set for a whole TTL window.
 */
export async function invalidateIamCacheForRole(roleId: string | null | undefined): Promise<void> {
  if (!roleId) return;
  try {
    const holders = await db
      .selectDistinct({
        principalType: roleAssignments.principalType,
        principalId: roleAssignments.principalId,
      })
      .from(roleAssignments)
      .where(eq(roleAssignments.roleId, roleId));
    for (const p of holders) {
      if (p.principalType === 'group') {
        await invalidateIamCacheForGroup(p.principalId);
      } else {
        invalidateIamCacheForUser(p.principalId);
      }
    }
  } catch (err) {
    console.warn('[iam-cache] role invalidation lookup failed', { roleId, err: (err as Error)?.message });
  }
}

/** Bust a single policy's principal (member→user, group→members). */
export async function invalidateIamCacheForPolicyPrincipal(
  principalType: string,
  principalId: string,
): Promise<void> {
  if (principalType === 'group') {
    await invalidateIamCacheForGroup(principalId);
  } else {
    invalidateIamCacheForUser(principalId);
  }
}
