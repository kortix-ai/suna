import { connectionSharedWithEveryone, type Connection } from '@kortix/sdk';

export type AccountVisibility =
  | { kind: 'you' }
  | { kind: 'everyone' }
  | { kind: 'named'; names: string[]; more: number };

/**
 * Who may use an account, as its card states it: only the viewer, everyone in
 * the project, or up to `limit` grant labels plus how many more.
 *
 * A member-owned row in this list is always the viewer's own (the API returns
 * no one else's). A shared account narrowed to the viewer alone is theirs too.
 */
export function accountVisibility(
  connection: Connection,
  viewerId: string | null | undefined,
  limit = 1,
): AccountVisibility {
  if (connection.owner_type !== 'project') return { kind: 'you' };
  if (connectionSharedWithEveryone(connection)) return { kind: 'everyone' };
  const shares = connection.shared_with ?? [];
  const [only] = shares;
  if (shares.length === 1 && only?.principal_type === 'member' && only.principal_id === viewerId) {
    return { kind: 'you' };
  }
  // Groups first and the viewer last, so the card names who ELSE can use it.
  const rank = (share: (typeof shares)[number]) =>
    share.principal_type === 'group' ? 0 : share.principal_id === viewerId ? 2 : 1;
  const labels = [...shares].sort((a, b) => rank(a) - rank(b)).map((share) => share.label);
  return { kind: 'named', names: labels.slice(0, limit), more: Math.max(0, labels.length - limit) };
}

/** Who a new account is for: the caller alone, the whole project, or picked people. */
export type NewAccountAudience = 'private' | 'project' | 'members';

/** What the Add account form holds, in Customize and in the chat connect dialog. */
export interface NewAccountDraft {
  label: string;
  audience: NewAccountAudience;
  picked: { memberIds: string[]; groupIds: string[] };
}

/**
 * `POST /connections` with a name an account of the same owner already uses
 * updates that account instead of adding one, so the form refuses the name.
 */
export function newAccountLabelTaken(
  draft: NewAccountDraft,
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
export function newAccountReady(
  draft: NewAccountDraft,
  rows: ReadonlyArray<{ label: string; owner_type: string }>,
  access: { canManageConnections: boolean; accountId: string | null | undefined },
): boolean {
  if (!draft.label.trim() || newAccountLabelTaken(draft, rows)) return false;
  if (draft.audience === 'private') return true;
  if (!access.canManageConnections) return false;
  if (draft.audience === 'project') return true;
  return Boolean(access.accountId) && draft.picked.memberIds.length + draft.picked.groupIds.length > 0;
}

/** The grants that narrow a new shared account to the picked people and groups. */
export function newAccountGrantees(
  picked: NewAccountDraft['picked'],
): Array<{ type: 'user' | 'group'; id: string }> {
  return [
    ...picked.memberIds.map((id) => ({ type: 'user' as const, id })),
    ...picked.groupIds.map((id) => ({ type: 'group' as const, id })),
  ];
}

/** The audience a connect link preselects: the agent's `project` only for someone who may share. */
export function newAccountAudienceFor(
  owner: 'me' | 'project' | undefined,
  canManageConnections: boolean,
): NewAccountAudience {
  return owner === 'project' && canManageConnections ? 'project' : 'private';
}

/**
 * Which connections belong to one connector's detail view.
 *
 * The API already scopes the list to the caller — every project-owned
 * connection plus only the caller's OWN member connections, never another
 * member's. This narrows that to a single connector and drops agent-owned
 * connections, which are an internal binding artifact rather than something a
 * person connected.
 *
 * Shared by the Connections list and the tab's count badge so the number on
 * the tab can never disagree with the rows underneath it.
 */
export function connectorConnectionRows<T extends { connector_alias: string; owner_type: string }>(
  connections: readonly T[] | undefined,
  connectorSlug: string,
): T[] {
  return (connections ?? []).filter(
    (connection) =>
      connection.connector_alias === connectorSlug && connection.owner_type !== 'agent',
  );
}
