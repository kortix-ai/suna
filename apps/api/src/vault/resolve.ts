// Resolve the effective set of vault values for an actor in a context, applying
// most-specific-wins precedence (see docs/specs/unified-iam-vault-access.md §5).
// Within the owner account A, for actor U, optional project P:
//
//   rank 6  private (owner_user_id=U) scoped to P
//   rank 5  private (owner_user_id=U) account-wide
//   rank 4  shared, scoped to P, granted to U  (select-members)
//   rank 3  shared, scoped to P, no grants      (global)
//   rank 2  shared, account-wide, granted to U
//   rank 1  shared, account-wide, no grants      (global)
//
// Higher rank wins on a name collision — so a member's personal OPENAI_KEY
// silently overrides the team's global one. No prompt.
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { vaultItemGrants, vaultItems } from '@kortix/db';
import { db } from '../shared/db';
import { decryptVaultValue } from './crypto';

type Candidate = {
  itemId: string;
  name: string;
  valueEnc: string;
  projectId: string | null;
  ownerUserId: string | null;
};

/**
 * Return the decrypted name→value map an actor should see when running in a
 * given (account, project) context. Used for sandbox env injection.
 */
export async function resolveVaultForActor(args: {
  accountId: string;
  projectId: string | null;
  userId: string;
}): Promise<Record<string, string>> {
  const { accountId, projectId, userId } = args;

  const scopeFilter = projectId
    ? or(eq(vaultItems.projectId, projectId), isNull(vaultItems.projectId))
    : isNull(vaultItems.projectId);

  const rows: Candidate[] = await db
    .select({
      itemId: vaultItems.itemId,
      name: vaultItems.name,
      valueEnc: vaultItems.valueEnc,
      projectId: vaultItems.projectId,
      ownerUserId: vaultItems.ownerUserId,
    })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.ownerAccountId, accountId),
        scopeFilter,
        // private-to-someone-else items are never visible
        or(isNull(vaultItems.ownerUserId), eq(vaultItems.ownerUserId, userId)),
      ),
    );

  if (rows.length === 0) return {};

  // Grants for the shared candidates (owner_user_id IS NULL).
  const sharedIds = rows.filter((r) => r.ownerUserId === null).map((r) => r.itemId);
  const grantedToUser = new Set<string>(); // item_ids granted to this user
  const hasAnyGrant = new Set<string>(); // item_ids that have ≥1 grant
  if (sharedIds.length > 0) {
    const grants = await db
      .select({ itemId: vaultItemGrants.itemId, userId: vaultItemGrants.userId })
      .from(vaultItemGrants)
      .where(inArray(vaultItemGrants.itemId, sharedIds));
    for (const g of grants) {
      hasAnyGrant.add(g.itemId);
      if (g.userId === userId) grantedToUser.add(g.itemId);
    }
  }

  const rankOf = (c: Candidate): number | null => {
    const onProject = projectId != null && c.projectId === projectId;
    if (c.ownerUserId === userId) return onProject ? 6 : 5; // private
    if (c.ownerUserId !== null) return null; // someone else's private (defensive)
    // shared
    if (hasAnyGrant.has(c.itemId)) {
      if (!grantedToUser.has(c.itemId)) return null; // restricted, not for us
      return onProject ? 4 : 2;
    }
    return onProject ? 3 : 1; // global
  };

  const best = new Map<string, { rank: number; valueEnc: string }>();
  for (const c of rows) {
    const rank = rankOf(c);
    if (rank == null) continue;
    const cur = best.get(c.name);
    if (!cur || rank > cur.rank) best.set(c.name, { rank, valueEnc: c.valueEnc });
  }

  const out: Record<string, string> = {};
  for (const [name, { valueEnc }] of best) {
    out[name] = decryptVaultValue(accountId, valueEnc);
  }
  return out;
}

/** Look up a single project-scoped GLOBAL (shared, no-grants) env value by
 *  name. Used by server-side flows with no acting member (e.g. webhook secret
 *  verification). */
export async function resolveProjectGlobalSecret(
  accountId: string,
  projectId: string,
  name: string,
): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: vaultItems.valueEnc })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.ownerAccountId, accountId),
        eq(vaultItems.projectId, projectId),
        isNull(vaultItems.ownerUserId),
        eq(vaultItems.name, name),
      ),
    )
    .limit(1);
  return row ? decryptVaultValue(accountId, row.valueEnc) : null;
}
