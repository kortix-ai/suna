/**
 * Pure, testable sorting for the project members list. Extracted from the
 * members page so the role-rank fallback — which prevents NaN comparisons when
 * a member has a role outside the known set — can be unit-tested.
 */

/** Rank used to order members by account role. Unknown roles sort last (99). */
function accountRoleRank(role: string): number {
  switch (role) {
    case 'owner':
      return 0;
    case 'admin':
      return 1;
    case 'member':
      return 2;
    default:
      return 99;
  }
}

/**
 * Sort members by role (owner → admin → member → unknown), then by label.
 * Pure and stable — never returns NaN, even for roles outside the known set
 * (the previous inline `{owner,admin,member}` map yielded `undefined - undefined`
 * = NaN, producing an unstable ordering).
 */
export function sortByRoleThenLabel<T extends { account_role: string }>(
  members: readonly T[],
  labelOf: (member: T) => string,
): T[] {
  return [...members].sort((a, b) => {
    const roleDelta = accountRoleRank(a.account_role) - accountRoleRank(b.account_role);
    if (roleDelta !== 0) return roleDelta;
    return labelOf(a).localeCompare(labelOf(b));
  });
}
