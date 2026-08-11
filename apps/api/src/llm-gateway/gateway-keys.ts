import { and, desc, eq } from 'drizzle-orm';
import { gatewayApiKeys } from '@kortix/db';
import { db } from '../shared/db';
import { generateGatewayKeyPair, hashSecretKey } from '../shared/crypto';

/**
 * Name of the short-lived key session-title generation mints for each internal
 * gateway call. It is Kortix's own plumbing rather than a customer key, so it is
 * DELETED (see deleteGatewayKey) the moment the call finishes instead of being
 * soft-revoked — one row per prompt, kept forever, would both bloat the table
 * and clutter the workspace's key list. The name is only for forensics on the
 * rare row a failed delete leaves behind; nothing keys off it, so a customer
 * key that happens to share it is an ordinary, listed, revocable key.
 */
export const INTERNAL_SESSION_TITLE_KEY_NAME = 'internal-session-title';

export interface CreatedGatewayKey {
  key_id: string;
  name: string;
  key_prefix: string;
  secret_key: string;
}

export async function createGatewayKey(params: {
  accountId: string;
  workspaceId: string;
  name: string;
  createdBy: string;
}): Promise<CreatedGatewayKey> {
  const { secretKey } = generateGatewayKeyPair();
  const secretKeyHash = hashSecretKey(secretKey);
  const keyPrefix = secretKey.slice(0, 14);

  const [row] = await db
    .insert(gatewayApiKeys)
    .values({
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      name: params.name,
      keyPrefix,
      secretKeyHash,
      createdBy: params.createdBy,
    })
    .returning({ keyId: gatewayApiKeys.keyId });

  return { key_id: row!.keyId, name: params.name, key_prefix: keyPrefix, secret_key: secretKey };
}

export async function listGatewayKeys(workspaceId: string) {
  return db
    .select({
      keyId: gatewayApiKeys.keyId,
      name: gatewayApiKeys.name,
      keyPrefix: gatewayApiKeys.keyPrefix,
      status: gatewayApiKeys.status,
      lastUsedAt: gatewayApiKeys.lastUsedAt,
      createdAt: gatewayApiKeys.createdAt,
    })
    .from(gatewayApiKeys)
    .where(eq(gatewayApiKeys.workspaceId, workspaceId))
    .orderBy(desc(gatewayApiKeys.createdAt));
}

/**
 * Hard-delete a key. Only for keys KORTIX itself minted for a single internal
 * call — a customer key is soft-revoked (revokeGatewayKey) so the audit trail
 * survives. Deliberately NOT reachable from any route: a name-based exclusion
 * from `listGatewayKeys` would have let anyone who can create a key mint a
 * valid, billable one that no owner or auditor could see or revoke.
 */
export async function deleteGatewayKey(workspaceId: string, keyId: string): Promise<boolean> {
  const rows = await db
    .delete(gatewayApiKeys)
    .where(and(eq(gatewayApiKeys.keyId, keyId), eq(gatewayApiKeys.workspaceId, workspaceId)))
    .returning({ keyId: gatewayApiKeys.keyId });
  return rows.length > 0;
}

export async function revokeGatewayKey(workspaceId: string, keyId: string): Promise<boolean> {
  const rows = await db
    .update(gatewayApiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(gatewayApiKeys.keyId, keyId), eq(gatewayApiKeys.workspaceId, workspaceId)))
    .returning({ keyId: gatewayApiKeys.keyId });
  return rows.length > 0;
}

export async function validateGatewayKey(
  secretKey: string,
): Promise<{ accountId: string; workspaceId: string; userId: string; keyId: string } | null> {
  const hash = hashSecretKey(secretKey);
  const [row] = await db
    .select({
      keyId: gatewayApiKeys.keyId,
      accountId: gatewayApiKeys.accountId,
      workspaceId: gatewayApiKeys.workspaceId,
      createdBy: gatewayApiKeys.createdBy,
      status: gatewayApiKeys.status,
      expiresAt: gatewayApiKeys.expiresAt,
    })
    .from(gatewayApiKeys)
    .where(eq(gatewayApiKeys.secretKeyHash, hash))
    .limit(1);

  if (!row || row.status !== 'active') return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  void db
    .update(gatewayApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(gatewayApiKeys.keyId, row.keyId))
    .catch(() => {});

  return {
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    userId: row.createdBy ?? row.accountId,
    keyId: row.keyId,
  };
}
