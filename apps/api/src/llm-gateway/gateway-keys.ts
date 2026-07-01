import type { Effect } from 'effect';
import { and, desc, eq } from 'drizzle-orm';
import { gatewayApiKeys } from '@kortix/db';
import { generateGatewayKeyPair, hashSecretKey } from '../shared/crypto';
import { runLlmGatewayDatabase } from './effect';

export interface CreatedGatewayKey {
  key_id: string;
  name: string;
  key_prefix: string;
  secret_key: string;
}

export async function createGatewayKey(params: {
  accountId: string;
  projectId: string;
  name: string;
  createdBy: string;
}): Promise<CreatedGatewayKey> {
  const { secretKey } = generateGatewayKeyPair();
  const secretKeyHash = hashSecretKey(secretKey);
  const keyPrefix = secretKey.slice(0, 14);

  const [row] = await runLlmGatewayDatabase((database) =>
    database
      .insert(gatewayApiKeys)
      .values({
        accountId: params.accountId,
        projectId: params.projectId,
        name: params.name,
        keyPrefix,
        secretKeyHash,
        createdBy: params.createdBy,
      })
      .returning({ keyId: gatewayApiKeys.keyId }),
  );

  return { key_id: row!.keyId, name: params.name, key_prefix: keyPrefix, secret_key: secretKey };
}

export async function listGatewayKeys(projectId: string) {
  return runLlmGatewayDatabase((database) =>
    database
      .select({
        keyId: gatewayApiKeys.keyId,
        name: gatewayApiKeys.name,
        keyPrefix: gatewayApiKeys.keyPrefix,
        status: gatewayApiKeys.status,
        lastUsedAt: gatewayApiKeys.lastUsedAt,
        createdAt: gatewayApiKeys.createdAt,
      })
      .from(gatewayApiKeys)
      .where(eq(gatewayApiKeys.projectId, projectId))
      .orderBy(desc(gatewayApiKeys.createdAt)),
  );
}

export async function revokeGatewayKey(projectId: string, keyId: string): Promise<boolean> {
  const rows = await runLlmGatewayDatabase((database) =>
    database
      .update(gatewayApiKeys)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(gatewayApiKeys.keyId, keyId), eq(gatewayApiKeys.projectId, projectId)))
      .returning({ keyId: gatewayApiKeys.keyId }),
  );
  return rows.length > 0;
}

export async function validateGatewayKey(
  secretKey: string,
): Promise<{ accountId: string; projectId: string; userId: string; keyId: string } | null> {
  const hash = hashSecretKey(secretKey);
  const [row] = await runLlmGatewayDatabase((database) =>
    database
      .select({
        keyId: gatewayApiKeys.keyId,
        accountId: gatewayApiKeys.accountId,
        projectId: gatewayApiKeys.projectId,
        createdBy: gatewayApiKeys.createdBy,
        status: gatewayApiKeys.status,
        expiresAt: gatewayApiKeys.expiresAt,
      })
      .from(gatewayApiKeys)
      .where(eq(gatewayApiKeys.secretKeyHash, hash))
      .limit(1),
  );

  if (!row || row.status !== 'active') return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  void runLlmGatewayDatabase((database) =>
    database
      .update(gatewayApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(gatewayApiKeys.keyId, row.keyId)),
  ).catch(() => {});

  return {
    accountId: row.accountId,
    projectId: row.projectId,
    userId: row.createdBy ?? row.accountId,
    keyId: row.keyId,
  };
}
