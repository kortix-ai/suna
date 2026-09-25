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
  const labels = shares.map((share) => share.label);
  return { kind: 'named', names: labels.slice(0, limit), more: Math.max(0, labels.length - limit) };
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
