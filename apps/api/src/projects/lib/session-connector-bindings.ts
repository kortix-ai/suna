import {
  type SessionConnectorBindings,
  SessionConnectorBindingsSchema,
} from '@kortix/api-contract';
import {
  executorConnectionProfiles,
  executorConnectors,
  projectSessionConnectorBindings,
  projectSessions,
  serviceAccounts,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';

export interface ValidatedSessionConnectorBinding {
  alias: string;
  profileId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
}

export interface ResolvedSessionConnectorProfile {
  profileId: string;
  connectorId: string;
  alias: string;
  status: 'active' | 'revoked' | 'error';
  isDefault: boolean;
  metadata: Record<string, unknown>;
  source: 'request' | 'default';
}

export function mayUseLegacyDefaultProfile(hasAnyDurableBinding: boolean): boolean {
  return !hasAnyDurableBinding;
}

const PUBLIC_TO_CANONICAL_CONNECTOR_ALIAS: Readonly<Record<string, string>> = {
  email: 'kortix_email',
  slack: 'kortix_slack',
  meet: 'kortix_meet',
};

export function canonicalConnectorAlias(alias: string): string {
  return PUBLIC_TO_CANONICAL_CONNECTOR_ALIAS[alias] ?? alias;
}

export function publicConnectorAlias(alias: string): string {
  return (
    Object.entries(PUBLIC_TO_CANONICAL_CONNECTOR_ALIAS).find(
      ([, canonical]) => canonical === alias,
    )?.[0] ?? alias
  );
}

export async function loadEmailInstallProfileId(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      metadata: executorConnectionProfiles.metadata,
      status: executorConnectionProfiles.status,
    })
    .from(executorConnectionProfiles)
    .innerJoin(
      executorConnectors,
      eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
    )
    .where(
      and(
        eq(executorConnectionProfiles.projectId, projectId),
        eq(executorConnectors.slug, canonicalConnectorAlias('email')),
      ),
    );
  return (
    rows.find(
      (row) =>
        row.status === 'active' && (row.metadata as Record<string, unknown>)?.inbox_id === inboxId,
    )?.profileId ?? null
  );
}

export async function ensureEmailSessionBinding(input: {
  projectId: string;
  sessionId: string;
  inboxId: string;
}): Promise<boolean> {
  const profileId = await loadEmailInstallProfileId(input.projectId, input.inboxId);
  if (!profileId) return false;
  const [profile] = await db
    .select({
      accountId: executorConnectionProfiles.accountId,
      connectorId: executorConnectionProfiles.connectorId,
    })
    .from(executorConnectionProfiles)
    .where(eq(executorConnectionProfiles.profileId, profileId))
    .limit(1);
  const [session] = await db
    .select({ accountId: projectSessions.accountId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!profile || !session || profile.accountId !== session.accountId) return false;
  await db
    .insert(projectSessionConnectorBindings)
    .values({
      sessionId: input.sessionId,
      accountId: session.accountId,
      projectId: input.projectId,
      connectorAlias: canonicalConnectorAlias('email'),
      connectorId: profile.connectorId,
      profileId,
      source: 'default',
      createdBy: null,
    })
    .onConflictDoNothing();
  const [binding] = await db
    .select({ profileId: projectSessionConnectorBindings.profileId })
    .from(projectSessionConnectorBindings)
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.connectorAlias, canonicalConnectorAlias('email')),
      ),
    )
    .limit(1);
  return binding?.profileId === profileId;
}

export function parseSessionConnectorBindings(
  value: unknown,
): { ok: true; bindings: SessionConnectorBindings | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, bindings: undefined };
  const parsed = SessionConnectorBindingsSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, bindings: parsed.data };
}

export async function validateSessionConnectorBindings(input: {
  accountId: string;
  projectId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  mayManageSystemProfiles: boolean;
  bindings: SessionConnectorBindings | undefined;
}): Promise<
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | { ok: false; error: string; code: string }
> {
  if (!input.bindings) return { ok: true, bindings: [] };

  const validated: ValidatedSessionConnectorBinding[] = [];
  for (const [requestedAlias, binding] of Object.entries(input.bindings)) {
    const alias = canonicalConnectorAlias(requestedAlias);
    const [row] = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorId: executorConnectionProfiles.connectorId,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        isDefault: executorConnectionProfiles.isDefault,
        status: executorConnectionProfiles.status,
        connectorEnabled: executorConnectors.enabled,
      })
      .from(executorConnectionProfiles)
      .innerJoin(
        executorConnectors,
        and(
          eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
          eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
          eq(executorConnectors.projectId, executorConnectionProfiles.projectId),
        ),
      )
      .where(
        and(
          eq(executorConnectionProfiles.profileId, binding.profile_id),
          eq(executorConnectionProfiles.accountId, input.accountId),
          eq(executorConnectionProfiles.projectId, input.projectId),
          eq(executorConnectors.slug, alias),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        ok: false,
        error: `Connector profile is not available for alias "${alias}" in this project`,
        code: 'CONNECTOR_PROFILE_NOT_FOUND',
      };
    }
    const mayUseProfile =
      (row.ownerType === 'member' &&
        row.ownerId === input.actingUserId &&
        !input.actingPrincipalIsServiceAccount) ||
      (row.ownerType === 'project' && row.isDefault) ||
      (row.ownerType !== 'member' && row.ownerType !== 'project' && input.mayManageSystemProfiles);
    if (!mayUseProfile) {
      // Deliberately match the cross-project response. A profile id is not an
      // authority, and callers must not be able to probe another member's
      // connected identities (including when the caller is a project manager).
      return {
        ok: false,
        error: `Connector profile is not available for alias "${alias}" in this project`,
        code: 'CONNECTOR_PROFILE_NOT_FOUND',
      };
    }
    if (row.status !== 'active') {
      return {
        ok: false,
        error: `Connector profile for alias "${alias}" is not active`,
        code: 'CONNECTOR_PROFILE_INACTIVE',
      };
    }
    if (!row.connectorEnabled) {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is disabled`,
        code: 'CONNECTOR_PROFILE_INACTIVE',
      };
    }
    validated.push({
      alias,
      profileId: row.profileId,
      connectorId: row.connectorId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
    });
  }
  return { ok: true, bindings: validated };
}

export async function persistSessionConnectorBindings(input: {
  sessionId: string;
  accountId: string;
  projectId: string;
  createdBy: string;
  bindings: ValidatedSessionConnectorBinding[];
}): Promise<void> {
  if (input.bindings.length === 0) return;
  await db.insert(projectSessionConnectorBindings).values(
    input.bindings.map((binding) => ({
      sessionId: input.sessionId,
      accountId: input.accountId,
      projectId: input.projectId,
      connectorAlias: binding.alias,
      connectorId: binding.connectorId,
      profileId: binding.profileId,
      source: 'request' as const,
      createdBy: input.createdBy,
    })),
  );
}

export function sessionConnectorBindingsRequirePrivateVisibility(
  bindings: readonly ValidatedSessionConnectorBinding[],
): boolean {
  return bindings.some((binding) => binding.ownerType === 'member');
}

export async function sessionHasMemberConnectorBinding(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ profileId: projectSessionConnectorBindings.profileId })
    .from(projectSessionConnectorBindings)
    .innerJoin(
      executorConnectionProfiles,
      eq(executorConnectionProfiles.profileId, projectSessionConnectorBindings.profileId),
    )
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.accountId, input.accountId),
        eq(projectSessionConnectorBindings.projectId, input.projectId),
        eq(executorConnectionProfiles.ownerType, 'member'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Resolve the effective profile on every Executor request. A present but
 * revoked/error binding never falls through to a project default.
 */
export async function resolveSessionConnectorProfile(input: {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  alias: string;
}): Promise<ResolvedSessionConnectorProfile | null> {
  if (input.sessionId) {
    const [session] = await db
      .select({
        sessionId: projectSessions.sessionId,
        createdBy: projectSessions.createdBy,
        visibility: projectSessions.visibility,
        createdByServiceAccountId: serviceAccounts.serviceAccountId,
      })
      .from(projectSessions)
      .leftJoin(
        serviceAccounts,
        and(
          eq(serviceAccounts.serviceAccountId, projectSessions.createdBy),
          eq(serviceAccounts.accountId, projectSessions.accountId),
        ),
      )
      .where(
        and(
          eq(projectSessions.sessionId, input.sessionId),
          eq(projectSessions.accountId, input.accountId),
          eq(projectSessions.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (!session) return null;

    const [bound] = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorId: executorConnectionProfiles.connectorId,
        status: executorConnectionProfiles.status,
        isDefault: executorConnectionProfiles.isDefault,
        metadata: executorConnectionProfiles.metadata,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        source: projectSessionConnectorBindings.source,
      })
      .from(projectSessionConnectorBindings)
      .innerJoin(
        executorConnectionProfiles,
        eq(executorConnectionProfiles.profileId, projectSessionConnectorBindings.profileId),
      )
      .where(
        and(
          eq(projectSessionConnectorBindings.sessionId, input.sessionId),
          eq(projectSessionConnectorBindings.accountId, input.accountId),
          eq(projectSessionConnectorBindings.projectId, input.projectId),
          eq(projectSessionConnectorBindings.connectorAlias, input.alias),
        ),
      )
      .limit(1);
    if (bound) {
      if (
        bound.ownerType === 'member' &&
        (session.createdByServiceAccountId !== null ||
          bound.ownerId !== session.createdBy ||
          session.visibility !== 'private')
      ) {
        return null;
      }
      return {
        profileId: bound.profileId,
        connectorId: bound.connectorId,
        status: bound.status,
        isDefault: bound.isDefault,
        source: bound.source,
        alias: input.alias,
        metadata: bound.metadata ?? {},
      };
    }

    // Once a session opts into durable profile selection, every connector must
    // be selected explicitly. Falling back for an unbound alias would let a
    // partially bound session inherit an unrelated project-wide credential.
    const [anyBinding] = await db
      .select({ sessionId: projectSessionConnectorBindings.sessionId })
      .from(projectSessionConnectorBindings)
      .where(
        and(
          eq(projectSessionConnectorBindings.sessionId, input.sessionId),
          eq(projectSessionConnectorBindings.accountId, input.accountId),
          eq(projectSessionConnectorBindings.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (!mayUseLegacyDefaultProfile(Boolean(anyBinding))) return null;
  }

  const [fallback] = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      connectorId: executorConnectionProfiles.connectorId,
      status: executorConnectionProfiles.status,
      isDefault: executorConnectionProfiles.isDefault,
      metadata: executorConnectionProfiles.metadata,
    })
    .from(executorConnectionProfiles)
    .innerJoin(
      executorConnectors,
      and(
        eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
        eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
        eq(executorConnectors.projectId, executorConnectionProfiles.projectId),
      ),
    )
    .where(
      and(
        eq(executorConnectionProfiles.accountId, input.accountId),
        eq(executorConnectionProfiles.projectId, input.projectId),
        eq(executorConnectionProfiles.isDefault, true),
        eq(executorConnectors.slug, input.alias),
      ),
    )
    .limit(1);
  if (!fallback) return null;
  return {
    ...fallback,
    alias: input.alias,
    metadata: fallback.metadata ?? {},
    source: 'default',
  };
}

export function canonicalConnectorBindings(value: unknown): string {
  const parsed = parseSessionConnectorBindings(value);
  if (!parsed.ok || !parsed.bindings) return '{}';
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed.bindings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([alias, binding]) => [alias, { profile_id: binding.profile_id }]),
    ),
  );
}

export function connectorBindingPayloadConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalConnectorBindings(existing) !== canonicalConnectorBindings(requested);
}
