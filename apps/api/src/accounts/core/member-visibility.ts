/**
 * Which account-member rows a given viewer is allowed to see.
 *
 * Full-roster visibility is a member-management capability. Managers (owners,
 * admins, or anyone granted `member.invite`) see every member. A plain member
 * sees only who runs the account — owners/admins — and themselves; it must
 * NOT enumerate the other bare members, because one account can host unrelated
 * invitees (e.g. a demo account with several prospect orgs) and a bare
 * membership must not leak the rest of the roster (identities OR its size).
 *
 * Pure and dependency-free so it can be unit-tested in isolation and reused by
 * anything that needs the "what can this viewer see" cut (list rows AND count).
 */
export function visibleMemberRows<T extends { userId: string; accountRole: string }>(
  rows: readonly T[],
  viewerUserId: string,
  canManageMembers: boolean,
): T[] {
  if (canManageMembers) return [...rows];
  return rows.filter((r) => r.userId === viewerUserId || r.accountRole !== 'member');
}
