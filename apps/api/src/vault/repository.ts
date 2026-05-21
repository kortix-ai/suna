// Vault data access — every item belongs to a project. Visibility:
//   ownerUserId set            → "only me" (private to that member)
//   ownerUserId null, no grants → "everyone on the project"
//   ownerUserId null, +grants   → "select members"
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { vaultItemGrants, vaultItems } from '@kortix/db';
import { db } from '../shared/db';
import { encryptVaultValue } from './crypto';

export type VaultKind = 'env' | 'api_key' | 'oauth_token' | 'oauth_client' | 'connection_secret';
export type VaultVisibility = 'everyone' | 'private' | 'select';

export type VaultItemRow = {
  itemId: string;
  projectId: string;
  kind: VaultKind;
  name: string;
  ownerUserId: string | null;
  providerId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const COLS = {
  itemId: vaultItems.itemId,
  projectId: vaultItems.projectId,
  kind: vaultItems.kind,
  name: vaultItems.name,
  ownerUserId: vaultItems.ownerUserId,
  providerId: vaultItems.providerId,
  createdBy: vaultItems.createdBy,
  createdAt: vaultItems.createdAt,
  updatedAt: vaultItems.updatedAt,
} as const;

const scopeWhere = (projectId: string, name: string, ownerUserId: string | null) =>
  and(
    eq(vaultItems.projectId, projectId),
    eq(vaultItems.name, name),
    ownerUserId === null ? isNull(vaultItems.ownerUserId) : eq(vaultItems.ownerUserId, ownerUserId),
  );

export async function upsertProjectItem(args: {
  projectId: string;
  name: string;
  value: string;
  kind?: VaultKind;
  ownerUserId?: string | null;
  providerId?: string | null;
  createdBy: string;
}): Promise<VaultItemRow> {
  const ownerUserId = args.ownerUserId ?? null;
  const valueEnc = encryptVaultValue(args.projectId, args.value);

  const [existing] = await db
    .select({ itemId: vaultItems.itemId })
    .from(vaultItems)
    .where(scopeWhere(args.projectId, args.name, ownerUserId))
    .limit(1);
  if (existing) {
    const [row] = await db
      .update(vaultItems)
      .set({ valueEnc, kind: args.kind ?? 'env', providerId: args.providerId ?? null, updatedAt: new Date() })
      .where(eq(vaultItems.itemId, existing.itemId))
      .returning(COLS);
    return row as VaultItemRow;
  }
  const [row] = await db
    .insert(vaultItems)
    .values({
      projectId: args.projectId,
      kind: args.kind ?? 'env',
      name: args.name,
      valueEnc,
      ownerUserId,
      providerId: args.providerId ?? null,
      createdBy: args.createdBy,
    })
    .returning(COLS);
  return row as VaultItemRow;
}

export async function listProjectItems(
  projectId: string,
): Promise<Array<VaultItemRow & { grantUserIds: string[] }>> {
  const rows = (await db.select(COLS).from(vaultItems).where(eq(vaultItems.projectId, projectId))) as VaultItemRow[];
  if (rows.length === 0) return [];
  const grants = await db
    .select({ itemId: vaultItemGrants.itemId, userId: vaultItemGrants.userId })
    .from(vaultItemGrants)
    .where(inArray(vaultItemGrants.itemId, rows.map((r) => r.itemId)));
  const byItem = new Map<string, string[]>();
  for (const g of grants) byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g.userId]);
  return rows.map((r) => ({ ...r, grantUserIds: byItem.get(r.itemId) ?? [] }));
}

export async function getVaultItem(itemId: string): Promise<VaultItemRow | null> {
  const [row] = await db.select(COLS).from(vaultItems).where(eq(vaultItems.itemId, itemId)).limit(1);
  return (row as VaultItemRow) ?? null;
}

/** Rotate value in place; key derives from the item's project. */
export async function updateVaultItemValue(itemId: string, projectId: string, value: string): Promise<void> {
  await db
    .update(vaultItems)
    .set({ valueEnc: encryptVaultValue(projectId, value), updatedAt: new Date() })
    .where(eq(vaultItems.itemId, itemId));
}

export async function deleteVaultItem(itemId: string): Promise<boolean> {
  const rows = await db.delete(vaultItems).where(eq(vaultItems.itemId, itemId)).returning({ itemId: vaultItems.itemId });
  return rows.length > 0;
}

export async function deleteProjectItemByScope(
  projectId: string,
  name: string,
  ownerUserId: string | null,
): Promise<void> {
  await db.delete(vaultItems).where(scopeWhere(projectId, name, ownerUserId));
}

export async function setItemGrants(itemId: string, userIds: string[]): Promise<void> {
  await db.delete(vaultItemGrants).where(eq(vaultItemGrants.itemId, itemId));
  const unique = [...new Set(userIds)];
  if (unique.length > 0) {
    await db.insert(vaultItemGrants).values(unique.map((userId) => ({ itemId, userId }))).onConflictDoNothing();
  }
}

export function visibilityOf(item: { ownerUserId: string | null }, grantCount: number): VaultVisibility {
  if (item.ownerUserId) return 'private';
  return grantCount > 0 ? 'select' : 'everyone';
}
