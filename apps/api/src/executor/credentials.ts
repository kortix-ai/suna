import { executorConnectionProfiles, executorConnectors, executorCredentials } from '@kortix/db';
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
import { and, eq, isNull, or } from 'drizzle-orm';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

/* ─── credentials (split per user) ────────────────────────────────────────── */

function userClause(userId: string | null) {
  return userId ? eq(executorCredentials.userId, userId) : isNull(executorCredentials.userId);
}

/** Resolve a credential value/binding (decrypted) for (connector, user|shared). */
export async function resolveCredentialValue(
  connectorId: string,
  userId: string | null,
): Promise<string | null> {
  const defaultProfileId = await defaultProfileIdForConnector(connectorId);
  const [row] = await db
    .select({ valueEnc: executorCredentials.valueEnc, projectId: executorConnectors.projectId })
    .from(executorCredentials)
    .innerJoin(
      executorConnectors,
      eq(executorConnectors.connectorId, executorCredentials.connectorId),
    )
    .where(
      and(
        eq(executorCredentials.connectorId, connectorId),
        userClause(userId),
        defaultProfileId
          ? or(
              eq(executorCredentials.profileId, defaultProfileId),
              isNull(executorCredentials.profileId),
            )
          : isNull(executorCredentials.profileId),
      ),
    )
    .limit(1);
  if (!row) return null;
  try {
    return decryptProjectSecret(row.projectId, row.valueEnc);
  } catch {
    return null;
  }
}

export async function credentialExists(
  connectorId: string,
  userId: string | null,
): Promise<boolean> {
  const defaultProfileId = await defaultProfileIdForConnector(connectorId);
  const [row] = await db
    .select({ id: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(
      and(
        eq(executorCredentials.connectorId, connectorId),
        userClause(userId),
        defaultProfileId
          ? or(
              eq(executorCredentials.profileId, defaultProfileId),
              isNull(executorCredentials.profileId),
            )
          : isNull(executorCredentials.profileId),
      ),
    )
    .limit(1);
  return !!row;
}

async function defaultProfileIdForConnector(connectorId: string): Promise<string | null> {
  const [profile] = await db
    .select({ profileId: executorConnectionProfiles.profileId })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.connectorId, connectorId),
        eq(executorConnectionProfiles.isDefault, true),
      ),
    )
    .limit(1);
  return profile?.profileId ?? null;
}

export async function resolveProfileCredentialValue(input: {
  connectorId: string;
  profileId: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: executorCredentials.valueEnc, projectId: executorConnectors.projectId })
    .from(executorCredentials)
    .innerJoin(
      executorConnectors,
      eq(executorConnectors.connectorId, executorCredentials.connectorId),
    )
    .where(
      and(
        eq(executorCredentials.connectorId, input.connectorId),
        eq(executorCredentials.profileId, input.profileId),
      ),
    )
    .limit(1);
  if (!row) return null;
  try {
    return decryptProjectSecret(row.projectId, row.valueEnc);
  } catch {
    return null;
  }
}

export async function profileCredentialExists(input: {
  connectorId: string;
  profileId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(
      and(
        eq(executorCredentials.connectorId, input.connectorId),
        eq(executorCredentials.profileId, input.profileId),
      ),
    )
    .limit(1);
  return !!row;
}

export async function upsertProfileCredential(input: {
  projectId: string;
  connectorId: string;
  profileId: string;
  value: string;
  kind?: 'secret' | 'connection';
  createdBy?: string | null;
}): Promise<void> {
  const [profile] = await db
    .select({ profileId: executorConnectionProfiles.profileId })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.profileId, input.profileId),
        eq(executorConnectionProfiles.connectorId, input.connectorId),
        eq(executorConnectionProfiles.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!profile) throw new Error('Connector profile not found');
  const valueEnc = encryptProjectSecret(input.projectId, input.value);
  const [existing] = await db
    .select({ credentialId: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(eq(executorCredentials.profileId, input.profileId))
    .limit(1);
  if (existing) {
    await db
      .update(executorCredentials)
      .set({ valueEnc, kind: input.kind ?? 'secret', updatedAt: new Date() })
      .where(eq(executorCredentials.credentialId, existing.credentialId));
  } else {
    await db.insert(executorCredentials).values({
      connectorId: input.connectorId,
      profileId: input.profileId,
      userId: null,
      kind: input.kind ?? 'secret',
      valueEnc,
      createdBy: input.createdBy ?? null,
    });
  }
  await db
    .update(executorConnectionProfiles)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(executorConnectionProfiles.profileId, input.profileId));
}

export async function ensureDefaultProfile(input: {
  projectId: string;
  connectorId: string;
  createdBy?: string | null;
}): Promise<string> {
  const [existing] = await db
    .select({ profileId: executorConnectionProfiles.profileId })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.connectorId, input.connectorId),
        eq(executorConnectionProfiles.isDefault, true),
      ),
    )
    .limit(1);
  if (existing) return existing.profileId;

  const [connector] = await db
    .select()
    .from(executorConnectors)
    .where(
      and(
        eq(executorConnectors.connectorId, input.connectorId),
        eq(executorConnectors.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!connector) throw new Error('Connector not found while creating its default profile');
  const [created] = await db
    .insert(executorConnectionProfiles)
    .values({
      accountId: connector.accountId,
      projectId: connector.projectId,
      connectorId: connector.connectorId,
      ownerType: 'project',
      ownerId: null,
      label: connector.name,
      status: 'active',
      isDefault: true,
      metadata: { migrated_from_legacy: false, connector_slug: connector.slug },
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ profileId: executorConnectionProfiles.profileId });
  if (created) return created.profileId;
  const [raced] = await db
    .select({ profileId: executorConnectionProfiles.profileId })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.connectorId, input.connectorId),
        eq(executorConnectionProfiles.isDefault, true),
      ),
    )
    .limit(1);
  if (!raced) throw new Error('Default connector profile could not be created');
  return raced.profileId;
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
  const profileId = await ensureDefaultProfile(opts);
  const valueEnc = encryptProjectSecret(opts.projectId, opts.value);
  const [existing] = await db
    .select({ id: executorCredentials.credentialId })
    .from(executorCredentials)
    .where(
      and(
        eq(executorCredentials.connectorId, opts.connectorId),
        userClause(opts.userId),
        or(eq(executorCredentials.profileId, profileId), isNull(executorCredentials.profileId)),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(executorCredentials)
      .set({ profileId, valueEnc, kind: opts.kind ?? 'secret', updatedAt: new Date() })
      .where(eq(executorCredentials.credentialId, existing.id));
  } else {
    await db.insert(executorCredentials).values({
      connectorId: opts.connectorId,
      profileId,
      userId: opts.userId,
      kind: opts.kind ?? 'secret',
      valueEnc,
      createdBy: opts.createdBy ?? null,
    });
  }
  // Reflect "connected" in the connector status.
  await db
    .update(executorConnectors)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(executorConnectors.connectorId, opts.connectorId));
}

/**
 * Remove a credential — disconnect. `userId=null` = shared; set = that member's
 * own. If no credentials remain for the connector, flip its status back to
 * `needs_auth` so it shows as needing connection again.
 */
export async function deleteCredential(connectorId: string, userId: string | null): Promise<void> {
  const defaultProfileId = await defaultProfileIdForConnector(connectorId);
  await db
    .delete(executorCredentials)
    .where(
      and(
        eq(executorCredentials.connectorId, connectorId),
        userClause(userId),
        defaultProfileId
          ? or(
              eq(executorCredentials.profileId, defaultProfileId),
              isNull(executorCredentials.profileId),
            )
          : isNull(executorCredentials.profileId),
      ),
    );
  if (!(await credentialExists(connectorId, userId))) {
    await db
      .update(executorConnectors)
      .set({ status: 'needs_auth', updatedAt: new Date() })
      .where(eq(executorConnectors.connectorId, connectorId));
  }
}
