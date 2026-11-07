/**
 * A connector's accounts: which rows a person sees, who may use each one, the
 * Add account draft and its checks, the name a new account gets, and the
 * grants that share or narrow an account.
 *
 * A connector profile is always the project's. An ACCOUNT (a
 * `connector_connections` row) is an authorized identity on it, owned by the
 * project (shared) or by one member (only you). Who may use a shared account is
 * a set of grants (`shared_with`); none means everyone in the project.
 *
 * Pure and framework-free, except `grantConnectionAccess`, which writes the
 * grants. The web connectors pages (`packages/ui`) and the TUI's `/connectors`
 * screen read the same rules from here.
 */

import { createAssignment } from '../rest/projects-client/assignments';
import {
  type AdminConnector,
  type Connection,
  type ConnectionShare,
  type ConnectionSharePrincipal,
  connectionSharedWithEveryone,
} from '../rest/projects-client/connectors';
import { isManagedConnectorProvider } from './connector-status';

// ─── Which rows ──────────────────────────────────────────────────────────────

/**
 * Which connections belong to one connector's detail view.
 *
 * The API already scopes the list to the caller: every project-owned
 * connection plus only the caller's OWN member connections. This narrows that
 * to a single connector and drops agent-owned connections (an internal binding
 * artifact, not something a person connected) and disconnected (revoked) ones.
 */
export function connectorConnectionRows<
  T extends { connector_alias: string; owner_type: string; status?: string },
>(connections: readonly T[] | undefined, connectorSlug: string): T[] {
  return (connections ?? []).filter(
    (connection) =>
      connection.connector_alias === connectorSlug &&
      connection.owner_type !== 'agent' &&
      connection.status !== 'revoked',
  );
}

/**
 * The connector's empty shared account: the row the server made with the
 * connector (`metadata.default_slot` `'project'`), never signed in, and the
 * only shared account. Older servers send no `authorized`: no slot then. A
 * direct connector that needs no credential (`requestAuthType` `'none'`) has
 * none: its first account already works.
 */
export function emptyWorkspaceConnectionSlot(
  connector: Pick<AdminConnector, 'provider'> & Partial<Pick<AdminConnector, 'requestAuthType'>>,
  rows: readonly Connection[],
): Connection | null {
  // `none` means the account works unsigned, for a direct connector only: a
  // managed app reports `none` because Composio holds its sign-in.
  if (connector.requestAuthType === 'none' && !isManagedConnectorProvider(connector.provider)) {
    return null;
  }
  const shared = rows.filter((row) => row.owner_type === 'project');
  const slot = shared.length === 1 ? shared[0]! : null;
  return slot?.authorized === false && slot.metadata?.default_slot === 'project' ? slot : null;
}

/** @deprecated Use `emptyWorkspaceConnectionSlot`. Kept permanently. */
export const emptyProjectConnectionSlot = emptyWorkspaceConnectionSlot;

/**
 * A connector's accounts as a person sees them: its rows minus revoked ones
 * and the server's empty shared slot (a placeholder, not an account anyone
 * added). The accounts list, the header and the connectors list all count
 * these, so they agree.
 */
export function listedConnectorAccounts(
  connections: readonly Connection[] | undefined,
  connector: Pick<AdminConnector, 'slug' | 'provider'> & Partial<Pick<AdminConnector, 'requestAuthType'>>,
): Connection[] {
  const rows = connectorConnectionRows(connections, connector.slug);
  const slot = emptyWorkspaceConnectionSlot(connector, rows);
  return rows.filter((connection) => connection !== slot && connection.status !== 'revoked');
}

/**
 * An account still to sign in. The API reports `authorized: false` for every
 * account without a credential, but a direct connector with no auth scheme
 * (an MCP server such as DeepWiki) has nothing to sign in: its account works
 * as made. A managed or computer account keeps the API's word.
 */
export function connectorAccountNeedsSignIn(
  connection: { authorized?: boolean },
  connector: Pick<AdminConnector, 'provider' | 'authSecret'>,
): boolean {
  if (connection.authorized !== false) return false;
  if (isManagedConnectorProvider(connector.provider) || connector.provider === 'computer') return true;
  return Boolean(connector.authSecret);
}

// ─── Who may use it ──────────────────────────────────────────────────────────

export type ConnectorAccountVisibility =
  | { kind: 'you' }
  | { kind: 'everyone' }
  | { kind: 'named'; names: string[]; more: number };

/**
 * Who may use an account, as its row states it: only the viewer, everyone in
 * the project, or up to `limit` grant labels plus how many more.
 *
 * A member-owned row in this list is always the viewer's own (the API returns
 * no one else's). A shared account narrowed to the viewer alone is theirs too.
 */
export function connectorAccountVisibility(
  connection: Connection,
  viewerId: string | null | undefined,
  limit = 1,
): ConnectorAccountVisibility {
  if (connection.owner_type !== 'project') return { kind: 'you' };
  if (connectionSharedWithEveryone(connection)) return { kind: 'everyone' };
  return connectorAudienceVisibility(connection.shared_with ?? [], viewerId, limit);
}

/**
 * The same statement for any audience list: a shared connector account's or a
 * project secret value's (`shared_with`). Empty, or a grant to the project, is
 * everyone.
 */
export function connectorAudienceVisibility(
  shares: readonly ConnectionShare[],
  viewerId: string | null | undefined,
  limit = 1,
): ConnectorAccountVisibility {
  if (shares.length === 0 || shares.some((share) => share.principal_type === 'project')) {
    return { kind: 'everyone' };
  }
  const [only] = shares;
  if (shares.length === 1 && only?.principal_type === 'member' && only.principal_id === viewerId) {
    return { kind: 'you' };
  }
  // Groups first and the viewer last, so the row names who ELSE can use it.
  const rank = (share: (typeof shares)[number]) =>
    share.principal_type === 'group' ? 0 : share.principal_id === viewerId ? 2 : 1;
  const labels = [...shares].sort((a, b) => rank(a) - rank(b)).map((share) => share.label);
  return { kind: 'named', names: labels.slice(0, limit), more: Math.max(0, labels.length - limit) };
}

// ─── Add account ─────────────────────────────────────────────────────────────

/** Who a new account is for: the caller alone, the whole project, or picked people. */
export type NewConnectorAccountAudience = 'private' | 'project' | 'members';

/** What the Add account form holds. */
export interface NewConnectorAccountDraft {
  label: string;
  audience: NewConnectorAccountAudience;
  /** `agentIds`: agents' service accounts — every session of the agent may use it. */
  picked: { memberIds: string[]; groupIds: string[]; agentIds?: string[] };
}

/**
 * `POST /connections` with a name an account of the same owner already uses
 * updates that account instead of adding one, so the form refuses the name.
 */
export function newConnectorAccountLabelTaken(
  draft: NewConnectorAccountDraft,
  rows: ReadonlyArray<{ label: string; owner_type: string }>,
): boolean {
  const label = draft.label.trim().toLowerCase();
  if (!label) return false;
  const privateAccount = draft.audience === 'private';
  return rows.some(
    (row) =>
      row.label.trim().toLowerCase() === label && (row.owner_type === 'member') === privateAccount,
  );
}

/** A free name, and for a shared account the manage right (and, narrowed, someone picked). */
export function newConnectorAccountReady(
  draft: NewConnectorAccountDraft,
  rows: ReadonlyArray<{ label: string; owner_type: string }>,
  access: { canManageConnections: boolean; accountId: string | null | undefined },
): boolean {
  if (!draft.label.trim() || newConnectorAccountLabelTaken(draft, rows)) return false;
  if (draft.audience === 'private') return true;
  if (!access.canManageConnections) return false;
  if (draft.audience === 'project') return true;
  return (
    Boolean(access.accountId) &&
    draft.picked.memberIds.length + draft.picked.groupIds.length + (draft.picked.agentIds?.length ?? 0) > 0
  );
}

/** The grants that narrow a new shared account to the picked people, groups and agents. */
export function newConnectorAccountGrantees(
  picked: NewConnectorAccountDraft['picked'],
): Array<{ type: 'user' | 'group' | 'service_account'; id: string }> {
  return [
    ...picked.memberIds.map((id) => ({ type: 'user' as const, id })),
    ...picked.groupIds.map((id) => ({ type: 'group' as const, id })),
    ...(picked.agentIds ?? []).map((id) => ({ type: 'service_account' as const, id })),
  ];
}

/** The audience a connect link preselects: the agent's `project` only for someone who may share. */
export function newConnectorAccountAudienceFor(
  owner: 'me' | 'project' | undefined,
  canManageConnections: boolean,
): NewConnectorAccountAudience {
  return owner === 'project' && canManageConnections ? 'project' : 'private';
}

/**
 * The name a new account gets: the app's name, then `<name> 2`, `<name> 3`.
 * `POST /connections` with a label an account of the same owner already uses
 * updates that account instead of adding one, so the label must be free.
 */
export function proposeConnectorAccountLabel(appName: string, taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()));
  const name = appName.trim();
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

// ─── Sharing an account ──────────────────────────────────────────────────────

/** Who is picked for an account: people, groups, agents, or everyone in the project. */
export interface ConnectionAudienceSelection {
  memberIds: string[];
  groupIds: string[];
  agentIds?: string[];
  everyone?: boolean;
}

export interface ConnectionSharePlan {
  /** Principals to grant, in the canonical assignment vocabulary. An agent is
   *  its service account. */
  add: Array<{ type: 'user' | 'group' | 'project' | 'service_account'; id: string }>;
  /** Assignment ids to revoke. */
  revoke: string[];
}

function repicked(grant: ConnectionShare, picked: ConnectionAudienceSelection): boolean {
  if (grant.principal_type === 'member') return picked.memberIds.includes(grant.principal_id);
  if (grant.principal_type === 'group') return picked.groupIds.includes(grant.principal_id);
  if (grant.principal_type === 'agent') return (picked.agentIds ?? []).includes(grant.principal_id);
  return picked.everyone === true;
}

/**
 * What saving a shared account's audience writes. A principal already granted
 * is never granted twice, and a grant marked for removal but picked again is
 * left alone (neither write). Write `add` before `revoke`: a shared account with
 * no grant is open to everyone, so revoking first would open it in between.
 */
export function planConnectionShare(
  current: readonly ConnectionShare[],
  removed: ReadonlySet<string>,
  picked: ConnectionAudienceSelection,
  projectId: string,
): ConnectionSharePlan {
  const granted = (type: ConnectionShare['principal_type'], id: string) =>
    current.some((grant) => grant.principal_type === type && grant.principal_id === id);
  const add: ConnectionSharePlan['add'] = [];
  for (const id of picked.memberIds) if (!granted('member', id)) add.push({ type: 'user', id });
  for (const id of picked.groupIds) if (!granted('group', id)) add.push({ type: 'group', id });
  for (const id of picked.agentIds ?? []) if (!granted('agent', id)) add.push({ type: 'service_account', id });
  if (picked.everyone && !current.some((grant) => grant.principal_type === 'project')) {
    add.push({ type: 'project', id: projectId });
  }
  const revoke = current
    .filter((grant) => removed.has(grant.grant_id) && !repicked(grant, picked))
    .map((grant) => grant.grant_id);
  return { add, revoke };
}

/**
 * Who a private account is shared with (`shareConnection`), or `null` when
 * nothing is picked (it stays private). Everyone in the project is the empty
 * audience.
 */
export function planPrivateConnectionShare(
  picked: ConnectionAudienceSelection,
  keepOwner: boolean,
  ownerId: string,
): ConnectionSharePrincipal[] | null {
  if (picked.everyone) return [];
  const others = [
    ...picked.memberIds
      .filter((id) => id !== ownerId)
      .map((id) => ({ principal_type: 'user' as const, principal_id: id })),
    ...picked.groupIds.map((id) => ({ principal_type: 'group' as const, principal_id: id })),
  ];
  const ownerPicked = picked.memberIds.includes(ownerId);
  if (others.length === 0 && !ownerPicked) return null;
  return keepOwner || ownerPicked
    ? [{ principal_type: 'user', principal_id: ownerId }, ...others]
    : others;
}

/** After saving, may everyone in the project use the account? No grant left,
 *  or a grant to the project, means yes. */
export function connectionSharedWithEveryoneAfter(
  current: readonly ConnectionShare[],
  removed: ReadonlySet<string>,
  picked: ConnectionAudienceSelection,
): boolean {
  if (picked.everyone) return true;
  const kept = current.filter((grant) => !removed.has(grant.grant_id) || repicked(grant, picked));
  if (kept.some((grant) => grant.principal_type === 'project')) return true;
  return (
    kept.length === 0 &&
    picked.memberIds.length + picked.groupIds.length + (picked.agentIds?.length ?? 0) === 0
  );
}

/** Grant each principal the use of one shared connector account, in parallel.
 *  The one write the share dialog and the Add account flow make. */
export async function grantConnectionAccess(
  accountId: string,
  projectId: string,
  connectionId: string,
  principals: ConnectionSharePlan['add'],
): Promise<void> {
  await Promise.all(
    principals.map((principal) =>
      createAssignment(accountId, {
        principal,
        roleKey: 'agent-user',
        scope: { type: 'project', id: projectId },
        object: { type: 'connection', id: connectionId },
      }),
    ),
  );
}
