/**
 * ONE access rule for a connector connection.
 *
 * A connector is a declared capability; it has no identity. An account
 * (`connector_connections` row) is an authorized identity on that service,
 * owned by the project (shared) or by one member (private). Reachability is a
 * property of the ROW, never of the connector.
 *
 * `connectors.authorization_strategy` used to decide this. It was a
 * connector-level mode that made the two owner types mutually exclusive, and it
 * was the direct cause of the original bug: a `user`-strategy connector had no
 * connect flow anywhere, because three separate call sites refused anything
 * that was not `project`. It is retired (the column stays, unread — see
 * migration `20260917160000000_revoke_unreachable_connector_connections`).
 *
 * Its one useful property — an unattended automation must never run as somebody's
 * personal account — moves onto the `member` row below. That is strictly better:
 * a trigger on a former `user` connector used to be able to use nothing at all,
 * and now uses the shared account when one exists while still never touching a
 * private one.
 */

export type ConnectionOwnerType =
  | 'project'
  | 'agent'
  | 'member'
  | 'subject'
  | 'external';

/** Agent-principal session reach: its on-behalf-of human and its own session visibility. */
export interface ConnectionAgentPrincipalReach {
  onBehalfOfUserId: string | null;
  visibility: 'private' | 'project' | 'restricted' | null;
}

/**
 * A SHARED (`project`-owned) account's audience, resolved for the ONE person a
 * call acts for (`agentPrincipal.onBehalfOfUserId` under an agent principal,
 * else the acting user):
 *
 *   `open` nobody narrowed the account (no `connection` grant), or it is
 *          shared with everyone in the project (a `project` principal grant)
 *   `in`   it is narrowed, and a grant names this person or one of their groups
 *   `out`  it is narrowed, and no grant names this person
 *
 * Every other owner type ignores it. `connection-audience.ts` resolves it.
 */
export type ConnectionAudienceReach = 'open' | 'in' | 'out';

/**
 * A narrowed shared account runs under the personal-account rules with its
 * audience in place of the owner, so like a personal account it never enters a
 * shared session: another member of that session could make the agent act as
 * an account they are not in the audience of.
 */
export function connectionNeedsPrivateSession(
  ownerType: ConnectionOwnerType,
  audience: ConnectionAudienceReach,
): boolean {
  return ownerType === 'member' || (ownerType === 'project' && audience !== 'open');
}

/**
 * | owner_type | reachable by                                                    |
 * |------------|-----------------------------------------------------------------|
 * | `project`  | audience `open`: anyone who may use the connector — humans AND  |
 * |            | service accounts. Audience `in`/`out`: the personal-account     |
 * |            | rules below, with "the audience names them" for "is the owner"  |
 * | `member`   | only `ownerId === actingUserId`; NEVER a service account.       |
 * |            | Agent-principal session: only `ownerId === on_behalf_of` in a   |
 * |            | `private` session (see `agentPrincipal` below)                  |
 * | `external` | only through `trustedManagedSystem` (the managed email channel) |
 * | `agent` / `subject` | nobody — unchanged, deliberately not widened           |
 *
 * The caller keeps its own session-visibility guard: a `member`-owned account is
 * reachable only inside a `private` session, so a shared session can never run
 * as one person's identity.
 *
 * `agentPrincipal` (spec docs/specs/2026-09-22-agents-as-principals.md §2.3):
 * present when the caller is an agent session under the agent-principal model
 * (flag `agent_principal` ON, governed grant). Its acting principal is the
 * agent's service account, so neither `actingUserId` (the launcher) nor the
 * service-account flag decides. A `member` row is reachable only when
 * `ownerId === onBehalfOfUserId` AND the session is `private`. An unattended
 * run (`onBehalfOfUserId` null) and a shared session reach no member row.
 */
export function connectionIsReachable(input: {
  ownerType: ConnectionOwnerType;
  ownerId: string | null;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  trustedManagedSystem?: boolean;
  agentPrincipal?: ConnectionAgentPrincipalReach | null;
  /**
   * The row's audience for the person this call acts for. Required so a new
   * call site cannot forget it: a path that MANAGES an account (rename,
   * re-credential, revoke, finish an authorization) rather than USES it passes
   * `'open'` and keeps its own manage-capability gate.
   */
  audience: ConnectionAudienceReach;
}): boolean {
  if (input.trustedManagedSystem === true) return true;
  if (input.ownerType === 'project') {
    if (input.audience === 'open') return true;
    if (input.agentPrincipal) {
      const human = input.agentPrincipal.onBehalfOfUserId;
      return (
        input.agentPrincipal.visibility === 'private' &&
        typeof human === 'string' &&
        human !== '' &&
        input.audience === 'in'
      );
    }
    return !input.actingPrincipalIsServiceAccount && input.audience === 'in';
  }
  if (input.ownerType !== 'member') return false;
  if (input.agentPrincipal) {
    const human = input.agentPrincipal.onBehalfOfUserId;
    return (
      input.agentPrincipal.visibility === 'private' &&
      typeof human === 'string' &&
      human !== '' &&
      input.ownerId === human
    );
  }
  // `actingUserId` defaults to '' where the caller has no human principal
  // (a service account, or a resolution with no user in context). An empty
  // owner id must never collide with it.
  return (
    !input.actingPrincipalIsServiceAccount &&
    input.ownerId !== null &&
    input.ownerId !== '' &&
    input.ownerId === input.actingUserId
  );
}

export function isTrustedManagedChannelAuthorization(input: {
  providerType: string;
  platform: string | null;
  ownerType: ConnectionOwnerType;
  ownerId: string | null;
  metadata: Record<string, unknown>;
}): boolean {
  const inboxId = input.metadata.inbox_id;
  return (
    input.providerType === 'channel' &&
    input.platform === 'email' &&
    input.ownerType === 'external' &&
    input.metadata.channel_connection === true &&
    typeof inboxId === 'string' &&
    inboxId.length > 0 &&
    input.ownerId === `agentmail:${inboxId}`
  );
}

/** The columns of a `connector_connections` row joined to its connector that
 *  decide reachability. */
export interface ConnectionReachabilityRow {
  ownerType: ConnectionOwnerType;
  ownerId: string | null;
  metadata: Record<string, unknown>;
  providerType: string;
  connectorConfig: Record<string, unknown>;
}

/** The principal asking to reach a connection row. */
export interface ConnectionReachabilityActor {
  userId: string;
  isServiceAccount: boolean;
  /** Agent-principal reach (spec 2026-09-22 §2.3); null = legacy rule. */
  agentPrincipal: ConnectionAgentPrincipalReach | null;
}

/**
 * `connectionIsReachable` for a loaded connection row. It derives the
 * trusted-managed-channel exception from the row and its connector config, so
 * every caller that holds a row asks the same question the same way.
 * `audience` is the row's audience for this actor (`'open'` on a path that
 * manages the account rather than uses it).
 */
export function connectionRowIsReachable(
  row: ConnectionReachabilityRow,
  actor: ConnectionReachabilityActor,
  audience: ConnectionAudienceReach,
): boolean {
  return connectionIsReachable({
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    actingUserId: actor.userId,
    actingPrincipalIsServiceAccount: actor.isServiceAccount,
    agentPrincipal: actor.agentPrincipal,
    audience,
    trustedManagedSystem: isTrustedManagedChannelAuthorization({
      providerType: row.providerType,
      platform:
        typeof row.connectorConfig.platform === 'string' ? row.connectorConfig.platform : null,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      metadata: row.metadata,
    }),
  });
}

/**
 * Whose account a connect flow authorizes. Chosen by the caller, never derived
 * from the connector.
 *
 *   `me`      the caller's own private account (the default everywhere — the
 *             human clicking Connect authorizes themselves)
 *   `project` the one account shared with the whole project, which is a
 *             deliberate admin action gated on the connections-manage capability
 */
export type ConnectorConnectOwner = 'project' | 'me';

export function parseConnectorConnectOwner(value: unknown): ConnectorConnectOwner | null {
  if (value === undefined || value === null || value === '') return 'me';
  return value === 'me' || value === 'project' ? value : null;
}
