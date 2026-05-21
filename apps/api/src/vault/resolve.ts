// Resolve the effective name→value map for a member running a session in a
// project. Most-specific wins on a name collision:
//   rank 3  only me      (owner_user_id = you)
//   rank 2  select        (granted to you)
//   rank 1  everyone      (shared, no grants)
// Decryption key derives from the project_id.
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { vaultItemGrants, vaultItems } from '@kortix/db';
import { db } from '../shared/db';
import { decryptVaultValue } from './crypto';

export async function resolveVaultForActor(args: {
  projectId: string;
  userId: string;
}): Promise<Record<string, string>> {
  const { projectId, userId } = args;

  // Items the actor could see: shared (owner_user_id null) + their own private.
  const rows = await db
    .select({ itemId: vaultItems.itemId, name: vaultItems.name, valueEnc: vaultItems.valueEnc, ownerUserId: vaultItems.ownerUserId })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.projectId, projectId),
        // shared (owner_user_id NULL) OR your own private
        or(isNull(vaultItems.ownerUserId), eq(vaultItems.ownerUserId, userId)),
      ),
    );

  const sharedIds = rows.filter((r) => r.ownerUserId === null).map((r) => r.itemId);
  const hasGrant = new Set<string>();
  const grantedToUser = new Set<string>();
  if (sharedIds.length > 0) {
    const grants = await db
      .select({ itemId: vaultItemGrants.itemId, userId: vaultItemGrants.userId })
      .from(vaultItemGrants)
      .where(inArray(vaultItemGrants.itemId, sharedIds));
    for (const g of grants) {
      hasGrant.add(g.itemId);
      if (g.userId === userId) grantedToUser.add(g.itemId);
    }
  }

  const best = new Map<string, { rank: number; valueEnc: string }>();
  const consider = (name: string, rank: number, valueEnc: string) => {
    const cur = best.get(name);
    if (!cur || rank > cur.rank) best.set(name, { rank, valueEnc });
  };

  for (const r of rows) {
    if (r.ownerUserId !== null) {
      if (r.ownerUserId !== userId) continue; // someone else's private
      consider(r.name, 3, r.valueEnc); // only me
    } else if (hasGrant.has(r.itemId)) {
      if (!grantedToUser.has(r.itemId)) continue; // select, not for us
      consider(r.name, 2, r.valueEnc);
    } else {
      consider(r.name, 1, r.valueEnc); // everyone
    }
  }

  const out: Record<string, string> = {};
  for (const [name, { valueEnc }] of best) out[name] = decryptVaultValue(projectId, valueEnc);
  return out;
}

/** A project's shared (everyone) secret by name — for server-side flows with no
 *  acting member, e.g. webhook HMAC verification. */
export async function resolveProjectGlobalSecret(projectId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: vaultItems.valueEnc })
    .from(vaultItems)
    .where(and(eq(vaultItems.projectId, projectId), eq(vaultItems.name, name), isNull(vaultItems.ownerUserId)))
    .limit(1);
  return row ? decryptVaultValue(projectId, row.valueEnc) : null;
}
