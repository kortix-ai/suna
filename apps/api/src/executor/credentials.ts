/**
 * Connector credentials. A connector is project-wide visible — the only
 * ACCESS gate is the agent-side `[[agents]].connectors` grant (iam/agent-scope.ts),
 * not anything stored on the connector itself. Credentials (executor_credentials)
 * are one row per (connector, user) — user NULL is the shared project
 * credential, the only mode written today (`per_user` — a set user, each
 * member's own — was removed 2026-07-05; every caller here passes
 * `userId: null`). Values are encrypted with the project key and resolved
 * server-side only. See docs/specs/executor.md §5–6.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { executorConnectors, executorCredentials } from '@kortix/db';
import { db } from '../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';

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

/**
 * Remove a credential — disconnect. `userId=null` = shared; set = that member's
 * own. If no credentials remain for the connector, flip its status back to
 * `needs_auth` so it shows as needing connection again.
 */
export async function deleteCredential(connectorId: string, userId: string | null): Promise<void> {
  await db
    .delete(executorCredentials)
    .where(and(eq(executorCredentials.connectorId, connectorId), userClause(userId)));
  const [remaining] = await db
    .select({ id: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(eq(executorCredentials.connectorId, connectorId))
    .limit(1);
  if (!remaining) {
    await db
      .update(executorConnectors)
      .set({ status: 'needs_auth', updatedAt: new Date() })
      .where(eq(executorConnectors.connectorId, connectorId));
  }
}
