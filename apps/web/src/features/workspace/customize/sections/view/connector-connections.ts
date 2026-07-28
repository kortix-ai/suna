/**
 * Which connection profiles belong to one connector's detail view.
 *
 * The API already scopes the list to the caller — every project-owned
 * connection plus only the caller's OWN member connections, never another
 * member's. This narrows that to a single connector and drops agent-owned
 * profiles, which are an internal binding artifact rather than something a
 * person connected.
 *
 * Shared by the Connections list and the tab's count badge so the number on
 * the tab can never disagree with the rows underneath it.
 */
export function connectorConnectionRows<T extends { connector_alias: string; owner_type: string }>(
  profiles: readonly T[] | undefined,
  connectorSlug: string,
): T[] {
  return (profiles ?? []).filter(
    (profile) => profile.connector_alias === connectorSlug && profile.owner_type !== 'agent',
  );
}
