import type { Effect } from 'effect';
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
import { accountGroupMembers, iamPolicies } from '@kortix/db';
import { runIamDatabase } from './effect';

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
    const rows = await runIamDatabase((database) =>
      database
        .select({ userId: accountGroupMembers.userId })
        .from(accountGroupMembers)
        .where(eq(accountGroupMembers.groupId, groupId)),
    );
    invalidateIamCacheForUsers(rows.map((r) => r.userId));
  } catch (err) {
    console.warn('[iam-cache] group invalidation lookup failed', { groupId, err: (err as Error)?.message });
  }
}

/**
 * A custom role's action set changed — bust every principal that holds it via an
 * iam_policy. Member principals bust directly; group principals fan out to their
 * members. Best-effort. Call after editing iam_role_actions or deleting a role.
 */
export async function invalidateIamCacheForRole(roleId: string | null | undefined): Promise<void> {
  if (!roleId) return;
  try {
    const policies = await runIamDatabase((database) =>
      database
        .select({ principalType: iamPolicies.principalType, principalId: iamPolicies.principalId })
        .from(iamPolicies)
        .where(eq(iamPolicies.roleId, roleId)),
    );
    for (const p of policies) {
      if (p.principalType === 'group') {
        await invalidateIamCacheForGroup(p.principalId);
      } else {
        // 'member' (user) or 'token' (service account = its own principal id).
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
