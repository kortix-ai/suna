/** The connector lists: the gateway catalog a principal can use (listCatalog) and the admin dashboard list (listConnectors). */
import { mapLimit } from '@kortix/registry';
import {
  connectorConnections,
  connectorActions,
  connectors,
  projectSecrets,
  projectSessions,
} from '@kortix/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { principalMayUseConnector } from './principal-access';
import {
  canonicalConnectorAlias,
  listEntitledConnectorConnections,
  listEntitledConnectorConnectionsBatch,
  resolveSessionConnectorConnectionOutcome,
} from '../projects/lib/session-connector-bindings';
import { config } from '../config';
import { db } from '../shared/db';
import { hideSupersededSlack } from './channel-rules';
import { resolveFallbackIcons } from './connector-icon';
import { connectorCatalogIcons } from './connector-catalog';
import { buildAdminConnectorViews } from './connector-list';
import {
  connectorIdsWithSharedCredentials,
  connectorIdsWithReachableMemberCredential,
} from './credentials';
import { resolveEffectiveAction } from './policy';
import type {
  AdminConnectorView,
  CatalogAccount,
  CatalogConnector,
  ConnectorPrincipal,
  ListCatalogOptions,
} from './router-contract';
import { COMPUTER_SLUG, withComputerCatalog } from './computers';
import { ensureProjectComputer } from './sync';
import {
  authOf,
  channelPlatform,
  connectorConnected,
  loadConnectorPoliciesForMany,
  loadDefaultModeFor,
  loadProjectPoliciesFor,
} from './db-deps-rows';

/** A session's connection visibility, defaulting to `private` (also the no-session default). */
async function sessionVisibility(
  sessionId: string | null,
): Promise<'private' | 'project' | 'restricted'> {
  const [session] = sessionId
    ? await db
        .select({ visibility: projectSessions.visibility })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1)
    : [];
  return session?.visibility ?? 'private';
}

/**
 * The accounts a principal may run one connector as, default first — the same
 * computation `GET .../connectors/{slug}/accounts` (`listConnectorAccounts`)
 * exposes, reused here so the catalog can carry it inline without a second
 * round trip per connector.
 */
async function catalogAccountsFor(
  p: ConnectorPrincipal,
  slug: string,
  visibility: 'private' | 'project' | 'restricted',
): Promise<CatalogAccount[]> {
  const entitled = await listEntitledConnectorConnections({
    accountId: p.accountId,
    projectId: p.projectId,
    alias: canonicalConnectorAlias(slug),
    actingUserId: p.userId,
    visibility,
    agentPrincipal: p.agentPrincipal ?? null,
  });
  return entitled.map((connection) => ({
    connection_id: connection.connectionId,
    label: connection.label,
    owner_type: connection.ownerType,
    is_default: connection.isDefault,
  }));
}

/** The catalog a principal can actually use (agent grant + credential present + not blocked). */
export async function listCatalog(
  p: ConnectorPrincipal,
  options: ListCatalogOptions = {},
): Promise<CatalogConnector[]> {
  const wantedSlug = options.slug ? canonicalConnectorAlias(options.slug) : null;
  if (!wantedSlug || wantedSlug === COMPUTER_SLUG) await ensureProjectComputer(p.projectId, p.userId);
  const allConns = hideSupersededSlack(
    await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, p.projectId), eq(connectors.enabled, true))),
  );
  const conns = wantedSlug
    ? allConns.filter((row) => canonicalConnectorAlias(row.slug) === wantedSlug)
    : allConns;
  if (conns.length === 0) return [];

  // Project-scoped layer is the same for every connector in this list — load once.
  const connectorIds = conns.map((row) => row.connectorId);
  const [projectPolicies, defaultMode, accountVisibility, actionsByConnector, policiesByConnector] =
    await Promise.all([
      loadProjectPoliciesFor(p.projectId),
      loadDefaultModeFor(p.projectId),
      // Same rule `listConnectorAccounts` uses: a private session can also see
      // the caller's own member-owned accounts, anything else stays project-only.
      // An agent-principal credential with no session is never `private`.
      p.agentPrincipal && !p.sessionId ? Promise.resolve('project' as const) : sessionVisibility(p.sessionId),
      // Batched: was one `connectorActions` select PER connector inside the
      // loop below. One `inArray` query for the whole catalog instead.
      db
        .select()
        .from(connectorActions)
        .where(inArray(connectorActions.connectorId, connectorIds))
        .then((rows) => {
          const map = new Map<string, typeof rows>();
          for (const row of rows) {
            const list = map.get(row.connectorId);
            if (list) list.push(row);
            else map.set(row.connectorId, [row]);
          }
          for (const conn of conns) {
            if (conn.providerType !== 'computer') continue;
            map.set(conn.connectorId, withComputerCatalog(conn.connectorId, 'computer', []));
          }
          return map;
        }),
      loadConnectorPoliciesForMany(connectorIds),
    ]);

  // Each connector's resolution reads only: its session outcome, its accounts
  // and its credential. They are independent (the session row is request-
  // memoized), so they run concurrently instead of one connector at a time.
  // Measured on dev-api 2026-09-27 with 8 connectors: 8.0-16.9 s, db n=71-80
  // serial; prod showed db n=113 on this route. Bounded, because a project can
  // hold dozens of connectors. `mapLimit` keeps the connector order.
  const CATALOG_RESOLVE_CONCURRENCY = 8;
  const resolved = await mapLimit(conns, CATALOG_RESOLVE_CONCURRENCY, async (row): Promise<CatalogConnector | null> => {
    // Per-agent assignment: an agent only sees connectors its grant lists —
    // consistent with the call gate, so it never lists a tool it can't invoke.
    // This is the ONLY access gate — connectors are project-wide visible to
    // every human with project access (no per-connector member scoping).
    // Canonical on both sides — the grant is canonicalized at construction.
    if (!principalMayUseConnector(p, canonicalConnectorAlias(row.slug))) return null;
    // The accounts come first, and they decide whether the connector is listed.
    // `resolveActiveConnectorConnection` answers "what would an UNNAMED call run
    // as" — and under the account_required rule that is null when several
    // accounts are reachable and none is pinned. A connector with two connected
    // Gmail accounts must not vanish from the catalog for exactly the reason it
    // is interesting; the agent sees its accounts and names one.
    // Ask the session-scoped resolver WHY, not just whether: `none` means the
    // session's scope (explicit empty scope, revoked pin, visibility) hides
    // this connector and the catalog must hide it too — the catalog never
    // advertises what a call would refuse. `ambiguous` is the one exception:
    // several reachable accounts, none pinned — the connector IS usable, the
    // agent just has to name an account, so it is listed with its accounts.
    const outcome = await resolveSessionConnectorConnectionOutcome({
      accountId: p.accountId,
      projectId: row.projectId,
      sessionId: p.sessionId,
      alias: row.slug,
      actingUserId: p.userId,
      account: null,
      agentPrincipal: p.agentPrincipal ?? null,
    });
    if (outcome.kind === 'none') return null;
    const connection =
      outcome.kind === 'ok' && outcome.connection.status === 'active' ? outcome.connection : null;
    if (outcome.kind === 'ok' && !connection) return null;
    const accounts = await catalogAccountsFor(p, row.slug, accountVisibility);
    const { hasAuth } = authOf(row);
    if (connection && hasAuth) {
      // Always the shared credential — `per_user` was removed 2026-07-05.
      if (!(await connectorConnected(row, null, connection))) return null;
    }
    const connectorPolicies = policiesByConnector.get(row.connectorId) ?? [];
    const actions = actionsByConnector.get(row.connectorId) ?? [];
    return {
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      status: row.status,
      actions: actions
        .filter(
          (a) =>
            resolveEffectiveAction({
              fullPath: `${row.slug}.${a.path}`,
              relPath: a.path,
              projectPolicies,
              connectorPolicies,
              risk: a.risk,
              defaultMode,
            }).action !== 'block',
        )
        .map((a) => ({
          path: a.path,
          name: a.name,
          description: a.description ?? '',
          risk: a.risk,
          inputSchema: options.includeSchemas === false ? null : (a.inputSchema ?? null),
          ...(options.includeOutputSchemas ? { outputSchema: a.outputSchema ?? null } : {}),
        })),
      accounts,
      // What an UNNAMED call runs as: the one pinned account, or the only
      // account. Several accounts with no pin is `null` — the call would be
      // refused with `account_required`, so the catalog must not promise one.
      default_account:
        accounts.find((account) => account.is_default)?.label ??
        (accounts.length === 1 ? accounts[0].label : null),
    };
  });
  return resolved.filter((entry): entry is CatalogConnector => entry !== null);
}

/**
 * A computer connector with no machine — no `connector_connections` row bound
 * to a tunnel — has nothing to manage and no call it could answer, so it is
 * not a connected connector and stays out of the admin list (KRTX-1492: a
 * fresh project's Connected tab listed the machineless built-in `computer`
 * connector as connected while its own dialog said "No account yet"). The
 * catalogue's native Computers card carries the Connect CTA instead, and the
 * row reappears the moment a machine is paired.
 */
async function hideMachinelessComputers<
  T extends { connectorId: string; providerType: string; slug: string; createdAt: Date },
>(
  rows: T[],
): Promise<T[]> {
  const computers = rows.filter((row) => row.providerType === 'computer');
  if (computers.length === 0) return rows;
  const computerIds = computers.map((row) => row.connectorId);
  const withMachine = new Set(
    (
      await db
        .selectDistinct({ connectorId: connectorConnections.connectorId })
        .from(connectorConnections)
        .where(
          and(
            inArray(connectorConnections.connectorId, computerIds),
            isNotNull(connectorConnections.tunnelId),
          ),
        )
    ).map((row) => row.connectorId),
  );
  return rows.filter(
    (row) => row.providerType !== 'computer' || withMachine.has(row.connectorId),
  );
}

/**
 * Admin list — sharing + credential mode + whether a credential is set.
 *
 * `actingUserId` answers it for THIS caller: a connector with no project-wide
 * shared credential but a credentialed account owned by the caller is
 * connected for them (connection-access.ts — reachability is per-row, not
 * per-connector). Omitted only by callers with no human principal (there is
 * nobody whose own account could make the difference); the project-wide
 * checks below still apply either way.
 */
export async function listConnectors(
  projectId: string,
  actingUserId?: string | null,
  options: { includeSchemas?: boolean } = {},
): Promise<AdminConnectorView[]> {
  await ensureProjectComputer(projectId, actingUserId ?? null);
  const conns = await hideMachinelessComputers(
    hideSupersededSlack(
      await db.select().from(connectors).where(eq(connectors.projectId, projectId)),
    ),
  );
  if (conns.length === 0) return [];

  const credentialRows = conns.filter((row) => {
    const { hasAuth } = authOf(row);
    return hasAuth && row.providerType !== 'channel';
  });
  const channelRows = conns.filter((row) => {
    const { hasAuth } = authOf(row);
    return hasAuth && row.providerType === 'channel';
  });
  // Composio rows need the same liveness question channel rows already ask.
  // `authOf` forces `hasAuth = true` for composio and the shared-credential
  // lookup below checks a table Composio never writes to, so a composio
  // connector serialized as `active` no matter whether its OAuth handshake ever
  // completed. `connectorConnected` already answers correctly for composio (it
  // reads `connected_account_id` / `is_no_auth` out of the connection metadata,
  // the same facts the gateway denies calls on) — it was simply never asked.
  const composioRows = conns.filter((row) => row.providerType === 'composio');
  const boundSecretIdentifiers = [
    ...new Set(
      credentialRows
        .map((row) => row.authSecret)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  const computerConnectorIds = new Set(
    conns.filter((row) => row.providerType === 'computer').map((row) => row.connectorId),
  );
  const [
    actions,
    credentialConnectorIds,
    memberCredentialedConnectorIds,
    connectedChannelSlugs,
    entitledByConnector,
    validBoundSecrets,
  ] =
    await Promise.all([
      db
        .select({
          connectorId: connectorActions.connectorId,
          path: connectorActions.path,
          name: connectorActions.name,
          description: connectorActions.description,
          risk: connectorActions.risk,
          // The full per-action JSON Schema is the bulk of this route's
          // payload (1.6 MB on prod). A caller that opts out
          // (`?include_schemas=false` — the dashboard and `kortix connectors
          // ls`) must not make Postgres detoast and ship every schema just for
          // the response to null it below.
          inputSchema:
            options.includeSchemas === false
              ? sql<Record<string, unknown> | null>`null`
              : connectorActions.inputSchema,
        })
        .from(connectorActions)
        .where(
          inArray(
            connectorActions.connectorId,
            conns.map((row) => row.connectorId),
          ),
        )
        .then((stored) => [
          ...stored.filter((action) => !computerConnectorIds.has(action.connectorId)),
          ...[...computerConnectorIds].flatMap((id) => withComputerCatalog(id, 'computer', [])),
        ]),
      connectorIdsWithSharedCredentials(credentialRows.map((row) => row.connectorId)),
      actingUserId
        ? connectorIdsWithReachableMemberCredential(
            credentialRows.map((row) => row.connectorId),
            actingUserId,
          )
        : Promise.resolve(new Set<string>()),
      Promise.all(
        channelRows.map(async (row) => [row.slug, await connectorConnected(row, null)] as const),
      ).then(
        (entries) => new Set(entries.filter(([, connected]) => connected).map(([slug]) => slug)),
      ),
      // The accounts THIS caller may run each connector as, default first —
      // same computation as `listConnectorAccounts` (the `.../accounts` route
      // and the MCP `accounts` tool read it), reused here so `kortix connectors
      // ls`/`show` carry it without a client round trip per connector, AND —
      // for Composio below — the SAME predicate the gateway applies at call
      // time to decide "is it connected at all" (resolves an entitled account
      // for THIS caller; `connectorConnected(row, null)` with no connection
      // argument always answered `false` for Composio, INC-2026-09-08-
      // CONNECTOR-GATEWAY E6). Dashboard-wide, not session-scoped, so
      // visibility is always `private`.
      //
      // ONE batched call for every connector in the project instead of one
      // `listEntitledConnectorConnections` call PER connector (was n=64 on a
      // ~20-connector project — see `listEntitledConnectorConnectionsBatch`'s
      // doc comment). Composio's authorization check below reads from this
      // SAME map instead of re-running the identical lookup a second time.
      listEntitledConnectorConnectionsBatch({
        accountId: conns[0]!.accountId,
        projectId,
        connectors: conns,
        actingUserId: actingUserId ?? undefined,
        visibility: 'private',
      }),
      boundSecretIdentifiers.length === 0
        ? Promise.resolve([])
        : db
            .select({ identifier: projectSecrets.identifier })
            .from(projectSecrets)
            .where(
              and(
                eq(projectSecrets.projectId, projectId),
                inArray(projectSecrets.identifier, boundSecretIdentifiers),
                isNull(projectSecrets.ownerUserId),
                eq(projectSecrets.active, true),
                eq(projectSecrets.strategy, 'broker'),
                eq(projectSecrets.consumer, 'connector'),
              ),
            ),
    ]);
  const accountsByConnector = new Map<string, CatalogAccount[]>(
    conns.map((row) => [
      row.connectorId,
      (entitledByConnector.get(row.connectorId) ?? []).map((connection) => ({
        connection_id: connection.connectionId,
        label: connection.label,
        owner_type: connection.ownerType,
        is_default: connection.isDefault,
      })),
    ]),
  );
  const authorizedComposioSlugs = new Set(
    composioRows
      .filter((row) => (entitledByConnector.get(row.connectorId) ?? []).length > 0)
      .map((row) => row.slug),
  );
  // `authorization_strategy` is a DERIVED SUMMARY now, not a setting. The
  // column is retired (see migration 20260917160000000) and the PUT route is an
  // inert no-op, but the field stays on the wire so an older client keeps
  // parsing the response. It answers one question: does this connector's live
  // set of accounts look private-only?
  const ownershipRows =
    conns.length === 0
      ? []
      : await db
          .select({
            connectorId: connectorConnections.connectorId,
            ownerType: connectorConnections.ownerType,
          })
          .from(connectorConnections)
          .where(
            and(
              inArray(
                connectorConnections.connectorId,
                conns.map((row) => row.connectorId),
              ),
              eq(connectorConnections.status, 'active'),
            ),
          );
  const memberOwned = new Set<string>();
  const projectOwned = new Set<string>();
  for (const row of ownershipRows) {
    if (row.ownerType === 'member') memberOwned.add(row.connectorId);
    else if (row.ownerType === 'project') projectOwned.add(row.connectorId);
  }

  const actionsByConnector = new Map<string, typeof actions>();
  for (const action of actions) {
    const current = actionsByConnector.get(action.connectorId) ?? [];
    current.push(action);
    actionsByConnector.set(action.connectorId, current);
  }

  const connectedSlugs = new Set(connectedChannelSlugs);
  const storedCredentialSlugs = new Set<string>();
  for (const row of credentialRows) {
    // Project-wide (shared) credential, OR the caller's own credentialed
    // member-owned account — either makes this connector connected FOR THIS
    // CALLER, same as a real gateway call would resolve it (connection-access.ts).
    if (
      credentialConnectorIds.has(row.connectorId) ||
      memberCredentialedConnectorIds.has(row.connectorId)
    ) {
      connectedSlugs.add(row.slug);
      storedCredentialSlugs.add(row.slug);
    }
  }
  const validBoundSecretIdentifiers = new Set(validBoundSecrets.map((row) => row.identifier));
  for (const row of credentialRows) {
    if (row.authSecret && validBoundSecretIdentifiers.has(row.authSecret)) {
      connectedSlugs.add(row.slug);
    }
  }
  for (const slug of authorizedComposioSlugs) connectedSlugs.add(slug);
  const fallbackIcons = await resolveFallbackIcons(
    conns.map((row) => ({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      config: row.config,
    })),
    {
      composioLogo: async (app) =>
        config.COMPOSIO_API_KEY ? (await import('./composio')).composioToolkitLogo(app) : null,
      catalogIcons: connectorCatalogIcons,
    },
  );
  const candidates = conns.map((row) => {
    const { auth, hasAuth } = authOf(row);
    const config = row.config as {
      icon_url?: unknown;
      sensitive?: unknown;
      catalog_source?: unknown;
    } | null;
    return {
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      iconUrl:
        typeof config?.icon_url === 'string' && config.icon_url
          ? config.icon_url
          : (fallbackIcons.get(row.slug) ?? null),
      // A composio connector whose authorization never completed reports
      // `needs_auth` rather than the stored `active`. The gateway already
      // refuses every call on such a connector, so reporting `active` made the
      // product contradict itself: a checkmark in the UI and `needs_auth` on
      // every tool call, with nothing explaining the gap. Prod 2026-08-28: all 6
      // GitHub connections carried a null `connected_account_id` and no GitHub
      // tool call had ever executed, while the connector read `active`.
      //
      // Read-side only. `disabled` and `error` are deliberate operator/sync
      // states and outrank this; the DB column is left alone.
      // Read-side only. `active` in the DB means "declared and synced"; a
      // connector that needs a credential/authorization it does not have is
      // reported as `needs_auth` so `kortix connectors ls` says the same thing
      // the gateway will (a call answers `connector_not_connected`). Before
      // this, an openapi connector with no stored credential listed as
      // `active` and then 404'd on call (incident E2).
      status:
        row.status === 'active' &&
        hasAuth &&
        row.providerType !== 'channel' &&
        !connectedSlugs.has(row.slug)
          ? ('needs_auth' as const)
          : row.status,
      authorizationStrategy:
        memberOwned.has(row.connectorId) && !projectOwned.has(row.connectorId)
          ? ('user' as const)
          : ('project' as const),
      sensitive: config?.sensitive === true,
      // A catalog fetched with one member's personal account is listed only to
      // people with an account on the connector (`resolveMcpCatalogCredential`).
      actions: (config?.catalog_source === 'member' &&
      (entitledByConnector.get(row.connectorId) ?? []).length === 0
        ? []
        : (actionsByConnector.get(row.connectorId) ?? [])
      ).map((a) => ({
        path: a.path,
        name: a.name,
        description: a.description ?? '',
        risk: a.risk,
        // The full per-action JSON Schema is the bulk of this route's payload
        // (1.6 MB on prod). It is included unless the caller passes
        // `includeSchemas: false` (`?include_schemas=false`): baked sandbox
        // CLIs read it and cannot be updated in place.
        inputSchema: options.includeSchemas === false ? null : (a.inputSchema ?? null),
      })),
      requestAuthType: auth.type,
      requiresAuth: hasAuth,
      secretIdentifier: row.authSecret,
      credentialSource: !hasAuth
        ? ('none' as const)
        : row.providerType === 'channel'
          ? ('platform' as const)
          : storedCredentialSlugs.has(row.slug)
            ? ('stored' as const)
            : row.authSecret
              ? ('project_secret' as const)
              : ('none' as const),
      accounts: accountsByConnector.get(row.connectorId) ?? [],
      defaultAccount: accountsByConnector.get(row.connectorId)?.[0]?.label ?? null,
      lastError: row.lastError,
    };
  });
  return buildAdminConnectorViews(candidates, connectedSlugs);
}
