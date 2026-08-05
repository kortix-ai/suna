import {
  type ConnectorAuthorizationRequiredProfile,
  type SessionConnectorBindings,
  SessionConnectorBindingsInputSchema,
} from '@kortix/api-contract';
import {
  executorConnectionProfiles,
  executorConnectors,
  projectSessionConnectorBindings,
  projectSessions,
  serviceAccounts,
} from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
} from '../../shared/connector-alias';
import {
  loadAgentMailInstall,
  loadSlackInstall,
  loadTeamsInstall,
} from '../../channels/install-store';
import {
  credentialExists,
  profileCredentialExists,
} from '../../executor/credentials';
import { db } from '../../shared/db';
import {
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
  type ConnectorAuthorizationStrategy,
} from './connector-authorization-strategy';

export interface ValidatedSessionConnectorBinding {
  alias: string;
  profileId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
  authorizationStrategy: ConnectorAuthorizationStrategy;
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

interface ConnectorAuthorizationRow {
  connectorId: string;
  projectId: string;
  slug: string;
  name: string;
  providerType: string;
  config: Record<string, unknown>;
  authorizationStrategy: ConnectorAuthorizationStrategy;
  enabled: boolean;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
}

interface ConnectorAuthorizationProfileRow {
  profileId: string;
  isDefault: boolean;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
  status: 'active' | 'revoked' | 'error';
  metadata: Record<string, unknown>;
}

function connectorPlatform(config: Record<string, unknown>): string | null {
  return typeof config.platform === 'string' ? config.platform : null;
}

function connectorRequiresAuthorization(connector: ConnectorAuthorizationRow): boolean {
  if (connector.providerType === 'pipedream' || connector.providerType === 'channel') return true;
  const auth = connector.config.auth;
  if (!auth || typeof auth !== 'object') return false;
  return (auth as Record<string, unknown>).type !== 'none';
}

export async function connectorAuthorizationIsConnected(input: {
  connector: ConnectorAuthorizationRow;
  profile: ConnectorAuthorizationProfileRow;
}): Promise<boolean> {
  const { connector, profile } = input;
  if (!connectorRequiresAuthorization(connector)) return true;
  if (connector.providerType === 'channel') {
    const platform = connectorPlatform(connector.config);
    const profileSlug =
      typeof profile.metadata.connector_slug === 'string'
        ? profile.metadata.connector_slug
        : connector.slug;
    if (platform === 'slack') {
      return (await loadSlackInstall(connector.projectId).catch(() => null)) !== null;
    }
    if (platform === 'teams') {
      return (await loadTeamsInstall(connector.projectId).catch(() => null)) !== null;
    }
    if (platform === 'email') {
      const install = await loadAgentMailInstall(connector.projectId, profileSlug).catch(
        () => null,
      );
      if (!install) return false;
      return (
        typeof profile.metadata.inbox_id !== 'string' ||
        install.inboxId === profile.metadata.inbox_id
      );
    }
    return false;
  }
  if (
    await profileCredentialExists({
      connectorId: connector.connectorId,
      profileId: profile.profileId,
    })
  ) {
    return true;
  }
  return (
    profile.ownerType === 'project' &&
    profile.isDefault &&
    (await credentialExists(connector.connectorId, null))
  );
}

function trustedManagedAuthorization(
  connector: ConnectorAuthorizationRow,
  profile: ConnectorAuthorizationProfileRow,
): boolean {
  return isTrustedManagedChannelAuthorization({
    providerType: connector.providerType,
    platform: connectorPlatform(connector.config),
    ownerType: profile.ownerType,
    ownerId: profile.ownerId,
    metadata: profile.metadata,
  });
}

export function mayUseLegacyDefaultProfile(hasAnyDurableBinding: boolean): boolean {
  return !hasAnyDurableBinding;
}

// Canonicalization lives in shared/ so pure IAM code can use it without
// inheriting this module's database dependency. Imported for local use and
// re-exported so existing importers are unaffected.
export { canonicalConnectorAlias, publicConnectorAlias };

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
  const parsed = SessionConnectorBindingsInputSchema.safeParse(value);
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
  /** @deprecated Authorization strategy is the only owner gate. */
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
        metadata: executorConnectionProfiles.metadata,
        connectorEnabled: executorConnectors.enabled,
        connectorStatus: executorConnectors.status,
        connectorName: executorConnectors.name,
        providerType: executorConnectors.providerType,
        connectorConfig: executorConnectors.config,
        authorizationStrategy: executorConnectors.authorizationStrategy,
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
          eq(executorConnectionProfiles.profileId, binding.authorization_id),
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
    const connector: ConnectorAuthorizationRow = {
      connectorId: row.connectorId,
      projectId: input.projectId,
      slug: alias,
      name: row.connectorName,
      providerType: row.providerType,
      config: row.connectorConfig,
      authorizationStrategy: row.authorizationStrategy,
      enabled: row.connectorEnabled,
      status: row.connectorStatus,
    };
    const profile: ConnectorAuthorizationProfileRow = {
      profileId: row.profileId,
      isDefault: row.isDefault,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      status: row.status,
      metadata: row.metadata,
    };
    if (
      !connectorAuthorizationMatchesStrategy({
        strategy: connector.authorizationStrategy,
        ownerType: profile.ownerType,
        ownerId: profile.ownerId,
        actingUserId: input.actingUserId,
        actingPrincipalIsServiceAccount: input.actingPrincipalIsServiceAccount,
        trustedManagedSystem: trustedManagedAuthorization(connector, profile),
      })
    ) {
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
    if (row.connectorStatus !== 'active') {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is not active`,
        code: 'CONNECTOR_PROFILE_INACTIVE',
      };
    }
    if (!(await connectorAuthorizationIsConnected({ connector, profile }))) {
      return {
        ok: false,
        error: `Connector authorization for alias "${alias}" is not connected`,
        code: 'CONNECTOR_PROFILE_INACTIVE',
      };
    }
    validated.push({
      alias,
      profileId: row.profileId,
      connectorId: row.connectorId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      authorizationStrategy: row.authorizationStrategy,
    });
  }
  return { ok: true, bindings: validated };
}

export type RequiredConnectorResolution =
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | {
      ok: false;
      code: 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE';
      /** Every unconfigured alias, so one refusal is one round trip to fix. */
      aliases: string[];
      connectorProfiles?: never;
    }
  | {
      ok: false;
      code: 'CONNECTOR_AUTHORIZATION_REQUIRED';
      connectorProfiles: ConnectorAuthorizationRequiredProfile[];
      aliases?: never;
    };

export class RequiredConnectorProfileUnavailableError extends Error {
  readonly code = 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE';

  /** Every unconfigured alias, matching what create's pre-flight returns. */
  readonly aliases: string[];

  /**
   * The first alias.
   *
   * Kept because callers read it, but the list is the contract: the docs tell
   * integrators this refusal names every failing alias, and a single-alias
   * throw made that false on the prompt path — a caller who fixed the one name
   * they were given got refused again by the next, once per round trip.
   */
  get alias(): string {
    return this.aliases[0] ?? '';
  }

  constructor(aliases: string | readonly string[]) {
    const list = (typeof aliases === 'string' ? [aliases] : [...aliases]).filter(
      (alias) => alias.length > 0,
    );
    const quoted = list.map((alias) => `"${alias}"`).join(', ');
    super(
      list.length === 1
        ? `Required connector profile ${quoted} is unavailable`
        : `Required connector profiles ${quoted} are unavailable`,
    );
    this.aliases = list;
    this.name = 'RequiredConnectorProfileUnavailableError';
  }
}

export async function resolveRequiredConnectorProfiles(input: {
  accountId: string;
  projectId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  aliases: readonly string[];
  explicitBindings?: readonly ValidatedSessionConnectorBinding[];
}): Promise<RequiredConnectorResolution> {
  const bindings: ValidatedSessionConnectorBinding[] = [];
  const missing: ConnectorAuthorizationRequiredProfile[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  const explicitlyBound = new Set(input.explicitBindings?.map((binding) => binding.alias) ?? []);
  for (const requestedAlias of input.aliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    if (explicitlyBound.has(alias)) continue;
    const [connectorRow] = await db
      .select({
        connectorId: executorConnectors.connectorId,
        projectId: executorConnectors.projectId,
        slug: executorConnectors.slug,
        name: executorConnectors.name,
        providerType: executorConnectors.providerType,
        config: executorConnectors.config,
        authorizationStrategy: executorConnectors.authorizationStrategy,
        enabled: executorConnectors.enabled,
        status: executorConnectors.status,
      })
      .from(executorConnectors)
      .where(
        and(
          eq(executorConnectors.accountId, input.accountId),
          eq(executorConnectors.projectId, input.projectId),
          eq(executorConnectors.slug, alias),
        ),
      )
      .limit(1);
    if (!connectorRow) {
      // Keep scanning. Returning on the first unconfigured alias would hand the
      // caller one alias per round trip, and a caller that has to guess how many
      // more refusals are queued cannot show the end-user a complete checklist.
      unavailable.push(publicConnectorAlias(alias));
      continue;
    }
    const connector: ConnectorAuthorizationRow = connectorRow;
    const profileRows = connector.enabled && connector.status === 'active'
      ? await db
          .select({
            profileId: executorConnectionProfiles.profileId,
            isDefault: executorConnectionProfiles.isDefault,
            ownerType: executorConnectionProfiles.ownerType,
            ownerId: executorConnectionProfiles.ownerId,
            status: executorConnectionProfiles.status,
            metadata: executorConnectionProfiles.metadata,
          })
          .from(executorConnectionProfiles)
          .where(
            and(
              eq(executorConnectionProfiles.accountId, input.accountId),
              eq(executorConnectionProfiles.projectId, input.projectId),
              eq(executorConnectionProfiles.connectorId, connector.connectorId),
              eq(executorConnectionProfiles.status, 'active'),
            ),
          )
          .orderBy(desc(executorConnectionProfiles.isDefault), executorConnectionProfiles.profileId)
      : [];
    let selected: ConnectorAuthorizationProfileRow | null = null;
    for (const profile of profileRows) {
      if (
        !connectorAuthorizationMatchesStrategy({
          strategy: connector.authorizationStrategy,
          ownerType: profile.ownerType,
          ownerId: profile.ownerId,
          actingUserId: input.actingUserId,
          actingPrincipalIsServiceAccount: input.actingPrincipalIsServiceAccount,
          trustedManagedSystem: trustedManagedAuthorization(connector, profile),
        })
      ) {
        continue;
      }
      if (await connectorAuthorizationIsConnected({ connector, profile })) {
        selected = profile;
        break;
      }
    }
    if (!selected) {
      missing.push({
        id: connector.connectorId,
        slug: publicConnectorAlias(connector.slug),
        name: connector.name,
        authorization_strategy: connector.authorizationStrategy,
      });
      continue;
    }
    bindings.push({
      alias,
      profileId: selected.profileId,
      connectorId: connector.connectorId,
      ownerType: selected.ownerType,
      ownerId: selected.ownerId,
      authorizationStrategy: connector.authorizationStrategy,
    });
  }
  // An unconfigured alias outranks a missing authorization. Only the project
  // owner can add the connector, so sending the end-user into a connect flow for
  // a connector that does not exist yet would strand them; the caller has to fix
  // the manifest first and will re-hit the authorization gate on the retry.
  if (unavailable.length > 0) {
    return {
      ok: false,
      code: 'REQUIRED_CONNECTOR_PROFILE_UNAVAILABLE',
      aliases: unavailable,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
      connectorProfiles: missing,
    };
  }
  return { ok: true, bindings };
}

export async function missingRequiredConnectorAuthorizationsForSession(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  aliases: readonly string[];
}): Promise<ConnectorAuthorizationRequiredProfile[]> {
  const missing: ConnectorAuthorizationRequiredProfile[] = [];
  // Collected, not thrown on sight. Create's pre-flight reports every
  // unconfigured alias at once and the docs promise the same shape here; a
  // throw inside the loop stopped at the first, so a project missing two
  // connectors took two failed prompts to discover the second.
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const requestedAlias of input.aliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    const resolved = await resolveSessionConnectorProfile({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      alias,
    });
    if (resolved) continue;
    const [connector] = await db
      .select({
        id: executorConnectors.connectorId,
        slug: executorConnectors.slug,
        name: executorConnectors.name,
        authorizationStrategy: executorConnectors.authorizationStrategy,
      })
      .from(executorConnectors)
      .where(
        and(
          eq(executorConnectors.accountId, input.accountId),
          eq(executorConnectors.projectId, input.projectId),
          eq(executorConnectors.slug, alias),
        ),
      )
      .limit(1);
    if (!connector) {
      unavailable.push(publicConnectorAlias(alias));
      continue;
    }
    missing.push({
      id: connector.id,
      slug: publicConnectorAlias(connector.slug),
      name: connector.name,
      authorization_strategy: connector.authorizationStrategy,
    });
  }
  // Same precedence as create's pre-flight: an alias with no connector at all
  // outranks one that merely needs authorizing. Sending someone into a connect
  // flow for a connector the project does not have would strand them there.
  if (unavailable.length > 0) {
    throw new RequiredConnectorProfileUnavailableError(unavailable);
  }
  return missing;
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
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
}): Promise<ResolvedSessionConnectorProfile | null> {
  const alias = canonicalConnectorAlias(input.alias);
  let actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  let visibility: 'private' | 'project' | 'restricted' = 'private';
  let connectorBindingsConfigured = false;
  let inheritUnbound = false;

  if (input.sessionId) {
    const [session] = await db
      .select({
        sessionId: projectSessions.sessionId,
        createdBy: projectSessions.createdBy,
        visibility: projectSessions.visibility,
        bindingsConfigured: projectSessions.connectorBindingsConfigured,
        inheritUnbound: projectSessions.connectorBindingsInheritUnbound,
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
    actingUserId = session.createdBy ?? '';
    actingPrincipalIsServiceAccount = session.createdByServiceAccountId !== null;
    visibility = session.visibility;
    connectorBindingsConfigured = session.bindingsConfigured;
    inheritUnbound = session.inheritUnbound;

    const [bound] = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorId: executorConnectionProfiles.connectorId,
        profileStatus: executorConnectionProfiles.status,
        isDefault: executorConnectionProfiles.isDefault,
        metadata: executorConnectionProfiles.metadata,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        source: projectSessionConnectorBindings.source,
        connectorName: executorConnectors.name,
        providerType: executorConnectors.providerType,
        connectorConfig: executorConnectors.config,
        authorizationStrategy: executorConnectors.authorizationStrategy,
        connectorEnabled: executorConnectors.enabled,
        connectorStatus: executorConnectors.status,
      })
      .from(projectSessionConnectorBindings)
      .innerJoin(
        executorConnectionProfiles,
        eq(executorConnectionProfiles.profileId, projectSessionConnectorBindings.profileId),
      )
      .innerJoin(
        executorConnectors,
        and(
          eq(executorConnectors.connectorId, projectSessionConnectorBindings.connectorId),
          eq(executorConnectors.accountId, projectSessionConnectorBindings.accountId),
          eq(executorConnectors.projectId, projectSessionConnectorBindings.projectId),
        ),
      )
      .where(
        and(
          eq(projectSessionConnectorBindings.sessionId, input.sessionId),
          eq(projectSessionConnectorBindings.accountId, input.accountId),
          eq(projectSessionConnectorBindings.projectId, input.projectId),
          eq(projectSessionConnectorBindings.connectorAlias, alias),
        ),
      )
      .limit(1);
    if (bound) {
      const connector: ConnectorAuthorizationRow = {
        connectorId: bound.connectorId,
        projectId: input.projectId,
        slug: alias,
        name: bound.connectorName,
        providerType: bound.providerType,
        config: bound.connectorConfig,
        authorizationStrategy: bound.authorizationStrategy,
        enabled: bound.connectorEnabled,
        status: bound.connectorStatus,
      };
      const profile: ConnectorAuthorizationProfileRow = {
        profileId: bound.profileId,
        isDefault: bound.isDefault,
        ownerType: bound.ownerType,
        ownerId: bound.ownerId,
        status: bound.profileStatus,
        metadata: bound.metadata,
      };
      if (
        !connector.enabled ||
        connector.status !== 'active' ||
        profile.status !== 'active' ||
        (profile.ownerType === 'member' && visibility !== 'private') ||
        !connectorAuthorizationMatchesStrategy({
          strategy: connector.authorizationStrategy,
          ownerType: profile.ownerType,
          ownerId: profile.ownerId,
          actingUserId,
          actingPrincipalIsServiceAccount,
          trustedManagedSystem: trustedManagedAuthorization(connector, profile),
        }) ||
        !(await connectorAuthorizationIsConnected({ connector, profile }))
      ) {
        return null;
      }
      return {
        profileId: bound.profileId,
        connectorId: bound.connectorId,
        status: bound.profileStatus,
        isDefault: bound.isDefault,
        source: bound.source,
        alias,
        metadata: bound.metadata ?? {},
      };
    }
    if (connectorBindingsConfigured && !inheritUnbound) return null;
  }

  // Hand the project-default fallback the SAME principal identity the original
  // inlined branch used: when a session is in scope, the session-resolved
  // service-account flag (line 715) is authoritative and detection must NOT
  // re-run (the original skipped it when `input.sessionId` was set). When no
  // session is in scope, pass the RAW caller value so the helper's
  // `=== undefined` detection runs exactly as before.
  const fallbackFromDefault = await resolveProjectDefaultConnectorProfile({
    accountId: input.accountId,
    projectId: input.projectId,
    alias,
    actingUserId,
    actingPrincipalIsServiceAccount: input.sessionId
      ? actingPrincipalIsServiceAccount
      : input.actingPrincipalIsServiceAccount,
    visibility,
  });
  return fallbackFromDefault;
}

/**
 * Project-default profile resolution — the fallback an UNBOUND alias resolves
 * to when no session binding covers it (or no session is in scope at all).
 *
 * Strategy/visibility/connectivity-aware: it walks the connector's active
 * profiles (default first), keeps the first that matches the connector's
 * authorization strategy, the session's visibility, and is actually
 * connected, and stamps it `source: 'default'`.
 *
 * Kept separate from `resolveSessionConnectorProfile` so callers that need the
 * project default can resolve it directly. Executor discovery and execution do
 * not call this helper. They use `resolveSessionConnectorProfile`, which also
 * enforces the stored session scope.
 */
export async function resolveProjectDefaultConnectorProfile(input: {
  accountId: string;
  projectId: string;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
}): Promise<ResolvedSessionConnectorProfile | null> {
  const alias = canonicalConnectorAlias(input.alias);
  let actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  let visibility: 'private' | 'project' | 'restricted' = input.visibility ?? 'private';

  if (
    input.actingPrincipalIsServiceAccount === undefined &&
    actingUserId.length > 0
  ) {
    const [serviceAccount] = await db
      .select({ id: serviceAccounts.serviceAccountId })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.serviceAccountId, actingUserId),
          eq(serviceAccounts.accountId, input.accountId),
        ),
      )
      .limit(1);
    actingPrincipalIsServiceAccount = serviceAccount !== undefined;
  }

  const [connectorRow] = await db
    .select({
      connectorId: executorConnectors.connectorId,
      projectId: executorConnectors.projectId,
      slug: executorConnectors.slug,
      name: executorConnectors.name,
      providerType: executorConnectors.providerType,
      config: executorConnectors.config,
      authorizationStrategy: executorConnectors.authorizationStrategy,
      enabled: executorConnectors.enabled,
      status: executorConnectors.status,
    })
    .from(executorConnectors)
    .where(
      and(
        eq(executorConnectors.accountId, input.accountId),
        eq(executorConnectors.projectId, input.projectId),
        eq(executorConnectors.slug, alias),
      ),
    )
    .limit(1);
  if (!connectorRow || !connectorRow.enabled || connectorRow.status !== 'active') return null;
  const connector: ConnectorAuthorizationRow = connectorRow;
  const profiles = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      isDefault: executorConnectionProfiles.isDefault,
      ownerType: executorConnectionProfiles.ownerType,
      ownerId: executorConnectionProfiles.ownerId,
      status: executorConnectionProfiles.status,
      metadata: executorConnectionProfiles.metadata,
    })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.accountId, input.accountId),
        eq(executorConnectionProfiles.projectId, input.projectId),
        eq(executorConnectionProfiles.connectorId, connector.connectorId),
        eq(executorConnectionProfiles.status, 'active'),
      ),
    )
    .orderBy(desc(executorConnectionProfiles.isDefault), executorConnectionProfiles.profileId);
  let fallback: ConnectorAuthorizationProfileRow | null = null;
  for (const profile of profiles) {
    if (
      !connectorAuthorizationMatchesStrategy({
        strategy: connector.authorizationStrategy,
        ownerType: profile.ownerType,
        ownerId: profile.ownerId,
        actingUserId,
        actingPrincipalIsServiceAccount,
        trustedManagedSystem: trustedManagedAuthorization(connector, profile),
      })
    ) {
      continue;
    }
    if (profile.ownerType === 'member' && visibility !== 'private') continue;
    if (await connectorAuthorizationIsConnected({ connector, profile })) {
      fallback = profile;
      break;
    }
  }
  if (!fallback) return null;
  return {
    profileId: fallback.profileId,
    connectorId: connector.connectorId,
    status: fallback.status,
    isDefault: fallback.isDefault,
    alias,
    metadata: fallback.metadata ?? {},
    source: 'default',
  };
}

/**
 * Return the authorization map that Executor resolves for the session now.
 *
 * A session without caller-configured bindings can use strategy-based defaults
 * without durable binding rows. Read-back must materialize those defaults.
 * Explicit-only sessions remain explicit-only because
 * `resolveSessionConnectorProfile` enforces the persisted inheritance state.
 */
export async function resolveEffectiveSessionConnectorBindings(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  grantedConnectors: string[] | 'all' | undefined;
}): Promise<SessionConnectorBindings> {
  const requestedAliases = Array.isArray(input.grantedConnectors)
    ? input.grantedConnectors
    : (
        await db
          .select({ alias: executorConnectors.slug })
          .from(executorConnectors)
          .where(
            and(
              eq(executorConnectors.accountId, input.accountId),
              eq(executorConnectors.projectId, input.projectId),
              eq(executorConnectors.enabled, true),
              eq(executorConnectors.status, 'active'),
            ),
          )
          .orderBy(executorConnectors.slug)
      ).map((row) => row.alias);

  const bindings: SessionConnectorBindings = {};
  const seen = new Set<string>();
  for (const requestedAlias of requestedAliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    const resolved = await resolveSessionConnectorProfile({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      alias,
    });
    if (!resolved) continue;
    bindings[publicConnectorAlias(resolved.alias)] = {
      authorization_id: resolved.profileId,
    };
  }
  return bindings;
}

export function canonicalConnectorBindings(value: unknown): string {
  const parsed = parseSessionConnectorBindings(value);
  if (!parsed.ok || !parsed.bindings) return '{}';
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed.bindings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([alias, binding]) => [
          alias,
          { authorization_id: binding.authorization_id },
        ]),
    ),
  );
}

export function connectorBindingPayloadConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalConnectorBindings(existing) !== canonicalConnectorBindings(requested);
}
