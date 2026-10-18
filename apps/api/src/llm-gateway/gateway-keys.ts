import { and, desc, eq } from 'drizzle-orm';
import { gatewayApiKeys, projects } from '@kortix/db';
import { db } from '../shared/db';
import { generateGatewayKeyPair, hashSecretKey } from '../shared/crypto';
import { hashSecretKeyAsync, markTokenValidated } from '../shared/token-hash';

/**
 * Name of the short-lived key session-title generation mints for each internal
 * gateway call. It is Kortix's own plumbing rather than a customer key, so it is
 * DELETED (see deleteGatewayKey) the moment the call finishes instead of being
 * soft-revoked — one row per prompt, kept forever, would both bloat the table
 * and clutter the project's key list. The name is only for forensics on the
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
  projectId: string;
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
      projectId: params.projectId,
      name: params.name,
      keyPrefix,
      secretKeyHash,
      createdBy: params.createdBy,
    })
    .returning({ keyId: gatewayApiKeys.keyId });

  return { key_id: row!.keyId, name: params.name, key_prefix: keyPrefix, secret_key: secretKey };
}

export async function listGatewayKeys(projectId: string) {
  // The list is the surface that names live credentials — the CLI reads
  // `keys ls` with the same meaning `tokens ls --mine` applies to PATs
  // ("keys that still authenticate"), and the settings card has no action for
  // a dead key either. A revoked row keeps its identity for refusal
  // attribution (`validateGatewayKey`), it just stops being listed.
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
    .where(and(eq(gatewayApiKeys.projectId, projectId), eq(gatewayApiKeys.status, 'active')))
    .orderBy(desc(gatewayApiKeys.createdAt));
}

/**
 * Hard-delete a key. Only for keys KORTIX itself minted for a single internal
 * call — a customer key is soft-revoked (revokeGatewayKey) so the audit trail
 * survives. Deliberately NOT reachable from any route: a name-based exclusion
 * from `listGatewayKeys` would have let anyone who can create a key mint a
 * valid, billable one that no owner or auditor could see or revoke.
 */
export async function deleteGatewayKey(projectId: string, keyId: string): Promise<boolean> {
  const rows = await db
    .delete(gatewayApiKeys)
    .where(and(eq(gatewayApiKeys.keyId, keyId), eq(gatewayApiKeys.projectId, projectId)))
    .returning({ keyId: gatewayApiKeys.keyId });
  return rows.length > 0;
}

export async function revokeGatewayKey(projectId: string, keyId: string): Promise<boolean> {
  const rows = await db
    .update(gatewayApiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(gatewayApiKeys.keyId, keyId), eq(gatewayApiKeys.projectId, projectId)))
    .returning({ keyId: gatewayApiKeys.keyId });
  return rows.length > 0;
}

/** Why a hash-matched key is refused. The identity is still real, so it rides
 *  on the refusal and the gateway can log the request against its account
 *  (KRTX-1749). */
export type GatewayKeyRefusalReason = 'revoked' | 'expired' | 'project_archived';

export interface GatewayKeyResolution {
  accountId: string;
  projectId: string;
  userId: string;
  keyId: string;
  /** Set when the presented secret hash-matches a stored row that is refused
   *  (revoked, expired, or its workspace archived). Absent = the key is valid. */
  refused?: GatewayKeyRefusalReason;
}

export async function validateGatewayKey(
  secretKey: string,
): Promise<GatewayKeyResolution | null> {
  const hash = await hashSecretKeyAsync(secretKey);
  const [row] = await db
    .select({
      keyId: gatewayApiKeys.keyId,
      accountId: gatewayApiKeys.accountId,
      projectId: gatewayApiKeys.projectId,
      createdBy: gatewayApiKeys.createdBy,
      status: gatewayApiKeys.status,
      expiresAt: gatewayApiKeys.expiresAt,
    })
    .from(gatewayApiKeys)
    // A key of a deleted workspace authorizes nothing (KRTX-1714): the
    // delete archives the project, and its revoke route answers 404 after.
    .innerJoin(projects, and(eq(projects.projectId, gatewayApiKeys.projectId), eq(projects.status, 'active')))
    .where(eq(gatewayApiKeys.secretKeyHash, hash))
    .limit(1);

  if (!row) {
    // The join above also drops the row of an archived project, so a refused
    // key of a deleted workspace would look identical to a garbage token.
    // One indexed re-read without the project filter names it: the refusal
    // keeps refusing (KRTX-1714 unchanged), only the observability gains an
    // owner. A secret matching NO row at all stays unattributed — garbage
    // traffic writes nothing.
    //
    // This read runs on every unknown token, so it is attacker-controllable:
    // a transient failure here must keep the plain 401, never turn it into a
    // 500. Losing the attribution is free; losing the refusal is not.
    try {
      const [dead] = await db
        .select({
          keyId: gatewayApiKeys.keyId,
          accountId: gatewayApiKeys.accountId,
          projectId: gatewayApiKeys.projectId,
          createdBy: gatewayApiKeys.createdBy,
          status: gatewayApiKeys.status,
          expiresAt: gatewayApiKeys.expiresAt,
          projectStatus: projects.status,
        })
        .from(gatewayApiKeys)
        .leftJoin(projects, eq(projects.projectId, gatewayApiKeys.projectId))
        .where(eq(gatewayApiKeys.secretKeyHash, hash))
        .limit(1);
      if (!dead) return null;
      const identity = {
        accountId: dead.accountId,
        projectId: dead.projectId,
        userId: dead.createdBy ?? dead.accountId,
        keyId: dead.keyId,
      };
      if (dead.status !== 'active') return { ...identity, refused: 'revoked' };
      if (dead.expiresAt && dead.expiresAt.getTime() < Date.now()) return { ...identity, refused: 'expired' };
      return { ...identity, refused: 'project_archived' };
    } catch {
      return null;
    }
  }
  const identity = {
    accountId: row.accountId,
    projectId: row.projectId,
    userId: row.createdBy ?? row.accountId,
    keyId: row.keyId,
  };
  if (row.status !== 'active') return { ...identity, refused: 'revoked' };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return { ...identity, refused: 'expired' };
  markTokenValidated(secretKey);

  void db
    .update(gatewayApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(gatewayApiKeys.keyId, row.keyId))
    .catch(() => {});

  return identity;
}
