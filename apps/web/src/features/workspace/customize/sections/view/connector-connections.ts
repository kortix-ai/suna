import { connectionSharedWithEveryone, type Connection } from '@kortix/sdk';

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
/**
 * Who a shared account's row says may use it: everyone in the project, or up
 * to `limit` names from its grants plus how many more. `null` for any account
 * that is not shared (a private one says "Only you" on its own).
 */
export function sharedAudienceSummary(
  connection: Connection,
  limit = 2,
): { kind: 'everyone' } | { kind: 'narrowed'; names: string[]; more: number } | null {
  if (connection.owner_type !== 'project') return null;
  if (connectionSharedWithEveryone(connection)) return { kind: 'everyone' };
  const labels = (connection.shared_with ?? []).map((share) => share.label);
  return { kind: 'narrowed', names: labels.slice(0, limit), more: Math.max(0, labels.length - limit) };
}

export function connectorConnectionRows<T extends { connector_alias: string; owner_type: string }>(
  connections: readonly T[] | undefined,
  connectorSlug: string,
): T[] {
  return (connections ?? []).filter(
    (connection) =>
      connection.connector_alias === connectorSlug && connection.owner_type !== 'agent',
  );
}
