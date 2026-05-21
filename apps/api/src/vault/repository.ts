// Vault data access. Scope of an item is (project_id, owner_user_id):
//   owner_user_id set → PRIVATE to that member; else SHARED
//   project_id set    → that project; else account-wide
// "Visibility" (UX sugar) maps to these + the grants list.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { vaultItemGrants, vaultItems } from '@kortix/db';
import { db } from '../shared/db';
import { encryptVaultValue } from './crypto';

export type VaultKind = 'env' | 'api_key' | 'oauth_token' | 'oauth_client' | 'connection_secret';
export type VaultVisibility = 'global' | 'private' | 'select';

export type VaultItemRow = {
  itemId: string;
  ownerAccountId: string;
  kind: VaultKind;
  name: string;
  projectId: string | null;
  ownerUserId: string | null;
  providerId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT_COLS = {
  itemId: vaultItems.itemId,
  ownerAccountId: vaultItems.ownerAccountId,
  kind: vaultItems.kind,
  name: vaultItems.name,
  projectId: vaultItems.projectId,
  ownerUserId: vaultItems.ownerUserId,
  providerId: vaultItems.providerId,
  createdBy: vaultItems.createdBy,
  createdAt: vaultItems.createdAt,
  updatedAt: vaultItems.updatedAt,
} as const;

function scopeMatch(accountId: string, name: string, projectId: string | null, ownerUserId: string | null) {
  return and(
    eq(vaultItems.ownerAccountId, accountId),
    eq(vaultItems.name, name),
    projectId === null ? isNull(vaultItems.projectId) : eq(vaultItems.projectId, projectId),
    ownerUserId === null ? isNull(vaultItems.ownerUserId) : eq(vaultItems.ownerUserId, ownerUserId),
  );
}

/** Insert or update (by scope) a vault item; returns the row. */
export async function upsertVaultItem(args: {
  accountId: string;
  name: string;
  value: string;
  kind?: VaultKind;
  projectId?: string | null;
  ownerUserId?: string | null;
  providerId?: string | null;
  createdBy: string;
}): Promise<VaultItemRow> {
  const projectId = args.projectId ?? null;
  const ownerUserId = args.ownerUserId ?? null;
  const valueEnc = encryptVaultValue(args.accountId, args.value);

  const [existing] = await db
    .select({ itemId: vaultItems.itemId })
    .from(vaultItems)
    .where(scopeMatch(args.accountId, args.name, projectId, ownerUserId))
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(vaultItems)
      .set({
        valueEnc,
        kind: args.kind ?? 'env',
        providerId: args.providerId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(vaultItems.itemId, existing.itemId))
      .returning(SELECT_COLS);
    return row as VaultItemRow;
  }

  const [row] = await db
    .insert(vaultItems)
    .values({
      ownerAccountId: args.accountId,
      kind: args.kind ?? 'env',
      name: args.name,
      valueEnc,
      projectId,
      ownerUserId,
      providerId: args.providerId ?? null,
      createdBy: args.createdBy,
    })
    .returning(SELECT_COLS);
  return row as VaultItemRow;
}

/** Rotate an item's value in place (scope unchanged). */
export async function updateVaultItemValue(accountId: string, itemId: string, value: string): Promise<void> {
  const valueEnc = encryptVaultValue(accountId, value);
  await db
    .update(vaultItems)
    .set({ valueEnc, updatedAt: new Date() })
    .where(and(eq(vaultItems.ownerAccountId, accountId), eq(vaultItems.itemId, itemId)));
}

export async function getVaultItem(accountId: string, itemId: string): Promise<VaultItemRow | null> {
  const [row] = await db
    .select(SELECT_COLS)
    .from(vaultItems)
    .where(and(eq(vaultItems.ownerAccountId, accountId), eq(vaultItems.itemId, itemId)))
    .limit(1);
  return (row as VaultItemRow) ?? null;
}

/** Delete a project-scoped GLOBAL (shared) item by name. Used by the legacy
 *  project-secrets DELETE route, now vault-backed. */
export async function deleteProjectGlobalSecret(accountId: string, projectId: string, name: string): Promise<void> {
  await db
    .delete(vaultItems)
    .where(
      and(
        eq(vaultItems.ownerAccountId, accountId),
        eq(vaultItems.projectId, projectId),
        isNull(vaultItems.ownerUserId),
        eq(vaultItems.name, name),
      ),
    );
}

export async function deleteVaultItem(accountId: string, itemId: string): Promise<boolean> {
  const rows = await db
    .delete(vaultItems)
    .where(and(eq(vaultItems.ownerAccountId, accountId), eq(vaultItems.itemId, itemId)))
    .returning({ itemId: vaultItems.itemId });
  return rows.length > 0;
}

/** List items + grant counts. Caller filters/authorizes. */
export async function listVaultItems(args: {
  accountId: string;
  projectId?: string | null;
}): Promise<Array<VaultItemRow & { grantUserIds: string[] }>> {
  const conds = [eq(vaultItems.ownerAccountId, args.accountId)];
  if (args.projectId !== undefined) {
    conds.push(args.projectId === null ? isNull(vaultItems.projectId) : eq(vaultItems.projectId, args.projectId));
  }
  const rows = (await db.select(SELECT_COLS).from(vaultItems).where(and(...conds))) as VaultItemRow[];
  if (rows.length === 0) return [];

  const grants = await db
    .select({ itemId: vaultItemGrants.itemId, userId: vaultItemGrants.userId })
    .from(vaultItemGrants)
    .where(inArray(vaultItemGrants.itemId, rows.map((r) => r.itemId)));
  const byItem = new Map<string, string[]>();
  for (const g of grants) {
    const list = byItem.get(g.itemId) ?? [];
    list.push(g.userId);
    byItem.set(g.itemId, list);
  }
  return rows.map((r) => ({ ...r, grantUserIds: byItem.get(r.itemId) ?? [] }));
}

/** Replace an item's grant list (the "select members" set). */
export async function setItemGrants(itemId: string, userIds: string[]): Promise<void> {
  await db.delete(vaultItemGrants).where(eq(vaultItemGrants.itemId, itemId));
  const unique = [...new Set(userIds)];
  if (unique.length > 0) {
    await db
      .insert(vaultItemGrants)
      .values(unique.map((userId) => ({ itemId, userId })))
      .onConflictDoNothing();
  }
}

export function visibilityOf(item: { ownerUserId: string | null }, grantCount: number): VaultVisibility {
  if (item.ownerUserId) return 'private';
  return grantCount > 0 ? 'select' : 'global';
}

/** Decrypt-free check: is this item usable by `userId` (for the grants UI)? */
export async function itemGrantUserIds(itemId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: vaultItemGrants.userId })
    .from(vaultItemGrants)
    .where(eq(vaultItemGrants.itemId, itemId));
  return rows.map((r) => r.userId);
}

// Re-export for callers that build raw scope queries.
export { sql };
