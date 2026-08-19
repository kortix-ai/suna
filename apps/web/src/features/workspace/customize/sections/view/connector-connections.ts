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
    (connection) => connection.connector_alias === connectorSlug && connection.owner_type !== 'agent',
  );
}
