import type { AdminConnector, ConnectorConfig } from '@kortix/sdk';

/**
 * The URL of the MCP server an `mcp` connector calls — the `url:` its
 * kortix.yaml entry declares, read through `getConnectorConfig`.
 *
 * `null` for every other provider: Composio, Pipedream, OpenAPI, GraphQL and
 * HTTP connectors have no MCP server of their own, and Kortix exposes no hosted
 * per-connector MCP endpoint (agents reach connectors through the sandbox's
 * stdio `kortix connectors mcp` server).
 */
export function connectorMcpUrl(
  connector: Pick<AdminConnector, 'provider'>,
  config: Pick<ConnectorConfig, 'url'> | null | undefined,
): string | null {
  if (connector.provider !== 'mcp') return null;
  const url = config?.url?.trim();
  return url ? url : null;
}
