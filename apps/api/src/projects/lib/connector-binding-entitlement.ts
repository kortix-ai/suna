import { connectorConnections, connectors, serviceAccounts } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { canonicalConnectorAlias } from '../../shared/connector-alias';
import { db } from '../../shared/db';
import { connectionNeedsPrivateSession } from './connection-access';
import { audiencePersonId, loadConnectionAudience } from './connection-audience';
import {
  type ConnectorConnectionRow,
  type ConnectorRequirementRow,
  type ResolvedSessionConnectorConnection,
  connectorConnectionIsConnected,
  sessionConnectionIsReachable,
} from './connector-binding-shared';
import type { AgentPrincipalPersonalScope } from './connector-binding-resolve';

/**
 * EVERY connection for this alias the caller is entitled to use, default first.
 *
 * One connector can hold several accounts — the project's shared one and each
 * member's own ("Work", "Personal"). Resolution used to stop at the first
 * match and nothing could reach the rest, so the only way to use a second
 * account was to pin it per session from a dropdown in the composer. The list
 * is the primitive now: the CLI prints it, a call selects from it by name, and
 * an unselected call takes the first entry exactly as before.
 *
 * Entitlement is three filters: the row's reachability for this principal
 * (`connectionRowIsReachable`), the session's visibility (a member-owned account
 * never leaks into a shared session), and whether the account is genuinely
 * connected.
 *
 * Order: the caller's own default private account, their other private
 * accounts, the project's default shared account, then the rest. A call that
 * names no account takes the first entry, so "my own identity first, the
 * project's shared one as the fallback" is the resolution rule.
 */
interface EntitledConnectorConnection {
  connectionId: string;
  connectorId: string;
  alias: string;
  /** Human-facing account name. What `--account` matches on. */
  label: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  isDefault: boolean;
  status: 'active' | 'revoked' | 'error';
  metadata: Record<string, unknown>;
}

/** The plain connection-row projection every entitled-connection list reads. */
function entitledConnectionRowSelect() {
  return {
    connectionId: connectorConnections.connectionId,
    label: connectorConnections.label,
    isDefault: connectorConnections.isDefault,
    ownerType: connectorConnections.ownerType,
    ownerId: connectorConnections.ownerId,
    status: connectorConnections.status,
    metadata: connectorConnections.metadata,
  };
}

export async function listEntitledConnectorConnections(input: {
  accountId: string;
  projectId: string;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
  /** See `resolveSessionConnectorConnectionOutcome`. With it, the
   *  service-account probe below is skipped: the rule keys on on_behalf_of. */
  agentPrincipal?: AgentPrincipalPersonalScope | null;
}): Promise<EntitledConnectorConnection[]> {
  const alias = canonicalConnectorAlias(input.alias);
  const actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  const visibility: 'private' | 'project' | 'restricted' = input.visibility ?? 'private';

  if (!input.agentPrincipal && input.actingPrincipalIsServiceAccount === undefined && actingUserId.length > 0) {
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
      connectorId: connectors.connectorId,
      projectId: connectors.projectId,
      slug: connectors.slug,
      name: connectors.name,
      providerType: connectors.providerType,
      config: connectors.config,
      enabled: connectors.enabled,
      status: connectors.status,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.accountId, input.accountId),
        eq(connectors.projectId, input.projectId),
        eq(connectors.slug, alias),
      ),
    )
    .limit(1);
  if (!connectorRow || !connectorRow.enabled || connectorRow.status !== 'active') return [];
  const connector: ConnectorRequirementRow = connectorRow;

  const rows = await db
    .select(entitledConnectionRowSelect())
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.accountId, input.accountId),
        eq(connectorConnections.projectId, input.projectId),
        eq(connectorConnections.connectorId, connector.connectorId),
        eq(connectorConnections.status, 'active'),
      ),
    )
    .orderBy(desc(connectorConnections.isDefault), connectorConnections.connectionId);

  const audienceOf = await loadConnectionAudience({
    projectId: input.projectId,
    accountId: input.accountId,
    userId: audiencePersonId({
      actingUserId,
      actingPrincipalIsServiceAccount,
      agentPrincipal: input.agentPrincipal,
    }),
    agentId: input.agentPrincipal?.agentId ?? null,
  });
  const entitled: EntitledConnectorConnection[] = [];
  for (const row of rows) {
    const connection: ConnectorConnectionRow = {
      connectionId: row.connectionId,
      isDefault: row.isDefault,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      status: row.status,
      metadata: row.metadata,
    };
    const audience = audienceOf(row.connectionId);
    if (
      !sessionConnectionIsReachable(
        connector,
        connection,
        {
          userId: actingUserId,
          isServiceAccount: actingPrincipalIsServiceAccount,
          agentPrincipal: input.agentPrincipal
            ? { onBehalfOfUserId: input.agentPrincipal.onBehalfOfUserId, agentId: input.agentPrincipal.agentId ?? null, visibility }
            : null,
        },
        audience,
      )
    ) {
      continue;
    }
    if (connectionNeedsPrivateSession(connection.ownerType, audience) && visibility !== 'private') continue;
    if (!(await connectorConnectionIsConnected({ connector, connection }))) continue;
    entitled.push({
      connectionId: row.connectionId,
      connectorId: connector.connectorId,
      alias,
      label: row.label,
      ownerType: row.ownerType,
      isDefault: row.isDefault,
      status: row.status,
      metadata: row.metadata ?? {},
    });
  }
  // Every member-owned row that survived the filter is the CALLER's own, so
  // owner type alone ranks the list. `sort` is stable, so rows inside a rank
  // keep the query's `connectionId` order.
  return entitled.sort(
    (a, b) => entitledConnectionRank(a) - entitledConnectionRank(b),
  );
}

function entitledConnectionRank(connection: EntitledConnectorConnection): number {
  if (connection.ownerType === 'member') return connection.isDefault ? 0 : 1;
  return connection.isDefault ? 2 : 3;
}

/**
 * `listEntitledConnectorConnections`, batched across MANY connectors in one
 * request instead of called once per connector.
 *
 * `GET /connectors/projects/:id/connectors` (db-deps.ts `listConnectors`) and
 * `GET /connectors/projects/:id/catalog` (`listCatalog`) each called
 * `listEntitledConnectorConnections` once PER connector — every invocation
 * re-ran its own service-account check, re-selected the `connectors` row by
 * alias (the caller already held that exact row), and re-selected
 * `connectorConnections` scoped to just that one connector. On a project with
 * ~20 connectors that is ~60 avoidable round trips (measured: n=64 on
 * `/connectors`, n=97 on `/catalog`).
 *
 * This is the SAME per-connection filter logic as `listEntitledConnectorConnections`
 * (`sessionConnectionIsReachable` → `connectionNeedsPrivateSession` →
 * `connectorConnectionIsConnected` → rank + sort) — only the three per-connector
 * lookups above are hoisted out of the loop and issued once for the whole
 * batch: the service-account check depends only on (accountId, actingUserId),
 * not on which connector is asked; the connector rows are supplied by the
 * caller instead of re-selected; and `connectorConnections` is fetched with
 * one `inArray` over every connector id instead of one `eq` per connector.
 */
export async function listEntitledConnectorConnectionsBatch(input: {
  accountId: string;
  projectId: string;
  /** Already-fetched, already-verified-enabled/active connector rows. */
  connectors: readonly ConnectorRequirementRow[];
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
  agentPrincipal?: AgentPrincipalPersonalScope | null;
}): Promise<Map<string, EntitledConnectorConnection[]>> {
  const result = new Map<string, EntitledConnectorConnection[]>();
  const eligible = input.connectors.filter((c) => c.enabled && c.status === 'active');
  if (eligible.length === 0) return result;

  const actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  const visibility: 'private' | 'project' | 'restricted' = input.visibility ?? 'private';

  if (
    !input.agentPrincipal &&
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

  const connectorIds = eligible.map((c) => c.connectorId);
  const rows = await db
    .select({
      connectorId: connectorConnections.connectorId,
      ...entitledConnectionRowSelect(),
    })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.accountId, input.accountId),
        eq(connectorConnections.projectId, input.projectId),
        inArray(connectorConnections.connectorId, connectorIds),
        eq(connectorConnections.status, 'active'),
      ),
    )
    .orderBy(desc(connectorConnections.isDefault), connectorConnections.connectionId);

  const rowsByConnector = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByConnector.get(row.connectorId);
    if (list) list.push(row);
    else rowsByConnector.set(row.connectorId, [row]);
  }

  const audienceOf = await loadConnectionAudience({
    projectId: input.projectId,
    accountId: input.accountId,
    userId: audiencePersonId({
      actingUserId,
      actingPrincipalIsServiceAccount,
      agentPrincipal: input.agentPrincipal,
    }),
    agentId: input.agentPrincipal?.agentId ?? null,
  });

  for (const connector of eligible) {
    const alias = canonicalConnectorAlias(connector.slug);
    const connectorRows = rowsByConnector.get(connector.connectorId) ?? [];
    // One connector's row throwing (e.g. a malformed config) must not blank
    // out every other connector in the batch — the original per-connector
    // call site wrapped each invocation in `.catch(() => [])`; matched here
    // per-connector so the fault stays isolated.
    let entitled: EntitledConnectorConnection[] = [];
    try {
      for (const row of connectorRows) {
        const connection: ConnectorConnectionRow = {
          connectionId: row.connectionId,
          isDefault: row.isDefault,
          ownerType: row.ownerType,
          ownerId: row.ownerId,
          status: row.status,
          metadata: row.metadata,
        };
        const audience = audienceOf(row.connectionId);
        if (
          !sessionConnectionIsReachable(
            connector,
            connection,
            {
              userId: actingUserId,
              isServiceAccount: actingPrincipalIsServiceAccount,
              agentPrincipal: input.agentPrincipal
                ? { onBehalfOfUserId: input.agentPrincipal.onBehalfOfUserId, agentId: input.agentPrincipal.agentId ?? null, visibility }
                : null,
            },
            audience,
          )
        ) {
          continue;
        }
        if (connectionNeedsPrivateSession(connection.ownerType, audience) && visibility !== 'private') {
          continue;
        }
        if (!(await connectorConnectionIsConnected({ connector, connection }))) continue;
        entitled.push({
          connectionId: row.connectionId,
          connectorId: connector.connectorId,
          alias,
          label: row.label,
          ownerType: row.ownerType,
          isDefault: row.isDefault,
          status: row.status,
          metadata: row.metadata ?? {},
        });
      }
    } catch {
      entitled = [];
    }
    entitled.sort((a, b) => entitledConnectionRank(a) - entitledConnectionRank(b));
    result.set(connector.connectorId, entitled);
  }
  return result;
}

/**
 * The outcome of picking one entitled account.
 *
 * THE RULE (INC-class, 2026-09-16): an unnamed (or `me`/`project`-shorthand)
 * connector call uses an account implicitly ONLY when exactly one account is
 * reachable, OR a human has deliberately pinned a default. A silent tie-break
 * among several equally-reachable accounts is a guess with real consequences
 * — mail sent from the wrong mailbox. `ambiguous` is a DISTINCT outcome from
 * `none` so a caller can never conflate "nothing here" with "several things
 * here and I refuse to guess which."
 */
type EntitledConnectionSelection =
  | { kind: 'none' }
  | { kind: 'one'; connection: EntitledConnectorConnection }
  | { kind: 'ambiguous'; connections: readonly EntitledConnectorConnection[] };

/** 0 → none; 1 → it; 2+ → the pinned one iff exactly one is pinned, else ambiguous. */
export function resolveEntitledTier(
  connections: readonly EntitledConnectorConnection[],
): EntitledConnectionSelection {
  if (connections.length === 0) return { kind: 'none' };
  if (connections.length === 1) return { kind: 'one', connection: connections[0]! };
  const pinned = connections.filter((c) => c.isDefault);
  if (pinned.length === 1) return { kind: 'one', connection: pinned[0]! };
  return { kind: 'ambiguous', connections };
}

/**
 * Pick one entitled account by name.
 *
 * Matches a connection id exactly, a label case-insensitively — the CLI prints
 * both, and a human types the label — or the two selector words:
 *
 *   `me`      the caller's pinned private account, else their only private
 *             one, else AMBIGUOUS among their private accounts.
 *   `project` the pinned shared account, else the only shared one, else
 *             AMBIGUOUS among the shared accounts.
 *
 * The words are matched BEFORE labels, so a connection literally labelled
 * "me" is still reachable by its id. An unnamed call (no `account` at all)
 * applies the same 0/1/pinned/ambiguous rule to the WHOLE entitled list,
 * unfiltered — this is what replaced "always take the first entry".
 *
 * A named-but-unknown account returns `none`, which the caller reports as "no
 * such account" rather than silently running as a different one than asked
 * for. Silently falling back would be the worst outcome here: the call would
 * succeed against the wrong mailbox. `ambiguous` is reported differently
 * (`account_required`): several real candidates exist and none was named.
 */
export function selectEntitledConnectorConnection(
  connections: readonly EntitledConnectorConnection[],
  account: string | null | undefined,
): EntitledConnectionSelection {
  if (!account || !account.trim()) return resolveEntitledTier(connections);
  const wanted = account.trim().toLowerCase();
  if (wanted === 'me') {
    return resolveEntitledTier(connections.filter((c) => c.ownerType === 'member'));
  }
  if (wanted === 'project') {
    return resolveEntitledTier(connections.filter((c) => c.ownerType !== 'member'));
  }
  const named =
    connections.find((c) => c.connectionId.toLowerCase() === wanted) ??
    connections.find((c) => c.label.trim().toLowerCase() === wanted) ??
    null;
  return named ? { kind: 'one', connection: named } : { kind: 'none' };
}

/** The outcome of resolving a connector connection: found, absent, or
 *  AMBIGUOUS (several reachable accounts, none named, none pinned — see
 *  `EntitledConnectionSelection`). A `null`-collapsing caller cannot tell
 *  "nothing here" from "several things here and nobody said which"; a caller
 *  that must (the gateway's `account_required` denial) uses this instead. */
export type ResolvedConnectorConnectionOutcome =
  | { kind: 'ok'; connection: ResolvedSessionConnectorConnection }
  | { kind: 'none' }
  | { kind: 'ambiguous'; accounts: readonly EntitledConnectorConnection[] };

/**
 * Project-default connection resolution — the fallback an UNBOUND alias resolves
 * to when no session binding covers it (or no session is in scope at all).
 *
 * A thin pick over `listEntitledConnectorConnections` + `selectEntitledConnectorConnection`,
 * which preserves the original ordering (default first, then connection id) and
 * the original three filters, so a call naming one account (or exactly one
 * reachable, or exactly one pinned) resolves to exactly what it always did.
 */
export async function resolveProjectDefaultConnectorConnectionOutcome(input: {
  accountId: string;
  projectId: string;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  visibility?: 'private' | 'project' | 'restricted';
  /** Name or id of the account to run as. Omitted = the default. */
  account?: string | null;
  agentPrincipal?: AgentPrincipalPersonalScope | null;
}): Promise<ResolvedConnectorConnectionOutcome> {
  const entitled = await listEntitledConnectorConnections(input);
  const selection = selectEntitledConnectorConnection(entitled, input.account);
  if (selection.kind === 'none') return { kind: 'none' };
  if (selection.kind === 'ambiguous') return { kind: 'ambiguous', accounts: selection.connections };
  const chosen = selection.connection;
  return {
    kind: 'ok',
    connection: {
      connectionId: chosen.connectionId,
      connectorId: chosen.connectorId,
      status: chosen.status,
      isDefault: chosen.isDefault,
      alias: chosen.alias,
      metadata: chosen.metadata,
      source: 'default',
      label: chosen.label,
      ownerType: chosen.ownerType,
    },
  };
}

/** `resolveProjectDefaultConnectorConnectionOutcome`, collapsed to the pre-existing
 *  `T | null` shape for the many callers that only ever asked "did this resolve" —
 *  `ambiguous` collapses to `null` here exactly like "nothing reachable" did
 *  before this rule existed; a caller that must tell them apart uses the
 *  outcome-returning sibling above directly. */
export async function resolveProjectDefaultConnectorConnection(
  input: Parameters<typeof resolveProjectDefaultConnectorConnectionOutcome>[0],
): Promise<ResolvedSessionConnectorConnection | null> {
  const outcome = await resolveProjectDefaultConnectorConnectionOutcome(input);
  return outcome.kind === 'ok' ? outcome.connection : null;
}
