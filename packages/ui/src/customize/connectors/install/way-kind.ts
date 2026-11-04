import type { DiscoverConnectorVariant } from '@kortix/sdk';

/** How one way to connect an app works: its catalogue kind, or the managed partner. */
export type WayKind = DiscoverConnectorVariant['kind'] | 'pipedream';

const LABELS: Record<WayKind, string> = {
  mcp: 'MCP',
  composio: 'Composio',
  kortix: 'Kortix',
  pipedream: 'Pipedream',
  openapi: 'REST API',
  graphql: 'GraphQL',
  postman: 'Postman',
  http: 'HTTP API',
  // Kept for the SDK type: the catalogue no longer lists CLIs.
  cli: 'CLI',
};

/** The badge a way to connect carries everywhere: cards, the app page, Install. */
export function wayKindLabel(kind: WayKind): string {
  return LABELS[kind] ?? kind.toUpperCase();
}
