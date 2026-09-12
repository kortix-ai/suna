import { describe, expect, test } from 'bun:test';

import {
  connectorConnectionIsReady,
  recommendedSurfaceVariant,
  surfacesRecommendedFirst,
} from './connector-detail-copy';

describe('connectorConnectionIsReady', () => {
  const connector = {
    provider: 'mcp' as const,
    status: 'active' as const,
    authorizationStrategy: 'project' as const,
    authSecret: 'TOKEN',
    secretSet: false,
  };

  test('treats active connectors with no authentication as ready', () => {
    expect(connectorConnectionIsReady({ ...connector, authSecret: null }, false)).toBe(true);
  });

  test('requires the strategy-compatible connection for user authorization', () => {
    const userConnector = { ...connector, authorizationStrategy: 'user' as const };
    expect(connectorConnectionIsReady(userConnector, false)).toBe(false);
    expect(connectorConnectionIsReady(userConnector, true)).toBe(true);
  });

  test('never reports disabled, errored, or unfinished OAuth connectors as ready', () => {
    expect(connectorConnectionIsReady({ ...connector, status: 'disabled' }, true)).toBe(false);
    expect(connectorConnectionIsReady({ ...connector, status: 'error' }, true)).toBe(false);
    expect(connectorConnectionIsReady({ ...connector, status: 'needs_auth' }, true)).toBe(false);
  });
});

describe('recommendedSurfaceVariant — MCP-first surface pick (COR-17)', () => {
  const mcp = { kind: 'mcp', connector: { provider: 'mcp' } };
  const openapi = { kind: 'openapi', connector: { provider: 'openapi' } };
  const docsOnly = { kind: 'graphql', connector: null };

  test('an addable MCP surface wins regardless of feed position', () => {
    expect(recommendedSurfaceVariant([openapi, docsOnly, mcp])).toBe(mcp);
  });

  test('an MCP surface without a template cannot win over an addable one', () => {
    const mcpDocsOnly = { kind: 'mcp', connector: null };
    expect(recommendedSurfaceVariant([mcpDocsOnly, openapi])).toBe(openapi);
  });

  test('falls back to the first addable surface, then the first surface', () => {
    expect(recommendedSurfaceVariant([docsOnly, openapi])).toBe(openapi);
    expect(recommendedSurfaceVariant([docsOnly])).toBe(docsOnly);
    expect(recommendedSurfaceVariant([])).toBe(null);
  });

  test('surfacesRecommendedFirst moves the pick to the front and keeps the rest stable', () => {
    expect(surfacesRecommendedFirst([openapi, docsOnly, mcp])).toEqual([mcp, openapi, docsOnly]);
    expect(surfacesRecommendedFirst([])).toEqual([]);
  });
});
