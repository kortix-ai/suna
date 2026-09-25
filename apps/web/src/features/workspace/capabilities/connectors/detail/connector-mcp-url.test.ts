import { describe, expect, test } from 'bun:test';

import { connectorMcpUrl } from './connector-mcp-url';

describe('connectorMcpUrl', () => {
  test('is the server URL an MCP connector calls, exactly as kortix.yaml declares it', () => {
    expect(connectorMcpUrl({ provider: 'mcp' }, { url: '  https://mcp.example.test/mcp  ' })).toBe(
      'https://mcp.example.test/mcp',
    );
  });

  test('is null before the config loads and when the config declares no URL', () => {
    expect(connectorMcpUrl({ provider: 'mcp' }, undefined)).toBeNull();
    expect(connectorMcpUrl({ provider: 'mcp' }, { url: null })).toBeNull();
    expect(connectorMcpUrl({ provider: 'mcp' }, { url: ' ' })).toBeNull();
  });

  test('is null for every provider that is not an MCP server', () => {
    for (const provider of ['openapi', 'http', 'graphql', 'composio', 'pipedream'] as const) {
      expect(connectorMcpUrl({ provider }, { url: 'https://api.example.test' })).toBeNull();
    }
  });
});
