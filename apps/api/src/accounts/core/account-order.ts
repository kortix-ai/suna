/**
 * Deterministic listing order for GET /v1/accounts.
 *
 * The memberships query has no ORDER BY, and the web landing door falls back
 * to `accounts[0]` when nothing is selected — so an unordered list made the
 * default landing account nondeterministic (see the sibling test). The order
 * clients can rely on: accounts the user owns first, then admin, then plain
 * memberships; oldest first within a role; account id as the final tie-break.
 */

const ROLE_WEIGHT: Record<string, number> = { owner: 0, admin: 1 };

interface OrderableAccountRow {
  accountId: string;
  accountRole: string | null;
  createdAt: Date | null;
}

export function sortAccountsForListing<T extends OrderableAccountRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const roleDelta =
      (ROLE_WEIGHT[a.accountRole ?? ''] ?? 2) - (ROLE_WEIGHT[b.accountRole ?? ''] ?? 2);
    if (roleDelta !== 0) return roleDelta;
    // A missing timestamp sorts last within its role — it is no evidence of age.
    const aTime = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });
}
