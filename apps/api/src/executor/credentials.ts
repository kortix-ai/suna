/**
 * Connector access + credentials — the split model. Access (who can use a
 * connector) lives on the connector (share_scope + executor_connector_grants).
 * Credentials are separate (executor_credentials), one row per (connector, user)
 * — user NULL = the shared project credential, a set user = that member's own
 * (per_user mode). Values are encrypted with the project key and resolved
 * server-side only. See docs/specs/executor.md §5–6.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  executorConnectorGrants,
  executorConnectors,
  executorCredentials,
} from '@kortix/db';
import { db } from '../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';
import { intentToScope, type SecretGrant, type ShareScope, type SharingIntent } from './share';

/* ─── access (connector sharing) ──────────────────────────────────────────── */

export async function loadConnectorGrants(connectorId: string): Promise<SecretGrant[]> {
  const rows = await db
    .select({ principalType: executorConnectorGrants.principalType, principalId: executorConnectorGrants.principalId })
    .from(executorConnectorGrants)
    .where(eq(executorConnectorGrants.connectorId, connectorId));
  return rows.map((r) => ({ principalType: r.principalType as 'member' | 'group', principalId: r.principalId }));
}

export async function loadGrantsForMany(connectorIds: string[]): Promise<Map<string, SecretGrant[]>> {
  const out = new Map<string, SecretGrant[]>();
  if (connectorIds.length === 0) return out;
  const rows = await db
    .select({
      connectorId: executorConnectorGrants.connectorId,
      principalType: executorConnectorGrants.principalType,
      principalId: executorConnectorGrants.principalId,
    })
    .from(executorConnectorGrants)
    .where(inArray(executorConnectorGrants.connectorId, connectorIds));
  for (const r of rows) {
    const list = out.get(r.connectorId) ?? [];
    list.push({ principalType: r.principalType as 'member' | 'group', principalId: r.principalId });
    out.set(r.connectorId, list);
  }
  return out;
}

/** Set a connector's access: scope + grants (replace). */
export async function setConnectorSharingDb(connectorId: string, intent: SharingIntent): Promise<void> {
  const { shareScope, grants } = intentToScope(intent);
  await db.update(executorConnectors).set({ shareScope, updatedAt: new Date() }).where(eq(executorConnectors.connectorId, connectorId));
  await db.delete(executorConnectorGrants).where(eq(executorConnectorGrants.connectorId, connectorId));
  if (grants.length > 0) {
    await db.insert(executorConnectorGrants).values(
      grants.map((g) => ({ connectorId, principalType: g.principalType, principalId: g.principalId })),
    );
  }
}

/* ─── credentials (split per user) ────────────────────────────────────────── */

function userClause(userId: string | null) {
  return userId ? eq(executorCredentials.userId, userId) : isNull(executorCredentials.userId);
}

/** Resolve a credential value/binding (decrypted) for (connector, user|shared). */
export async function resolveCredentialValue(connectorId: string, userId: string | null): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: executorCredentials.valueEnc, projectId: executorConnectors.projectId })
    .from(executorCredentials)
    .innerJoin(executorConnectors, eq(executorConnectors.connectorId, executorCredentials.connectorId))
    .where(and(eq(executorCredentials.connectorId, connectorId), userClause(userId)))
    .limit(1);
  if (!row) return null;
  try {
    return decryptProjectSecret(row.projectId, row.valueEnc);
  } catch {
    return null;
  }
}

export async function credentialExists(connectorId: string, userId: string | null): Promise<boolean> {
  const [row] = await db
    .select({ id: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(and(eq(executorCredentials.connectorId, connectorId), userClause(userId)))
    .limit(1);
  return !!row;
}

/** Store/replace a credential. `userId=null` = shared; set = that member's own. */
export async function upsertCredential(opts: {
  projectId: string;
  connectorId: string;
  userId: string | null;
  value: string;
  kind?: 'secret' | 'connection';
  createdBy?: string | null;
}): Promise<void> {
  const valueEnc = encryptProjectSecret(opts.projectId, opts.value);
  const [existing] = await db
    .select({ id: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(and(eq(executorCredentials.connectorId, opts.connectorId), userClause(opts.userId)))
    .limit(1);
  if (existing) {
    await db.update(executorCredentials).set({ valueEnc, kind: opts.kind ?? 'secret', updatedAt: new Date() }).where(eq(executorCredentials.credentialId, existing.id));
  } else {
    await db.insert(executorCredentials).values({
      connectorId: opts.connectorId,
      userId: opts.userId,
      kind: opts.kind ?? 'secret',
      valueEnc,
      createdBy: opts.createdBy ?? null,
    });
  }
  // Reflect "connected" in the connector status.
  await db.update(executorConnectors).set({ status: 'active', updatedAt: new Date() }).where(eq(executorConnectors.connectorId, opts.connectorId));
}

export type { ShareScope };
