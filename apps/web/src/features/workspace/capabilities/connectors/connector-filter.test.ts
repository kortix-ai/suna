import { describe, expect, test } from 'bun:test';
import type { AdminConnector } from '@kortix/sdk';
import {
  connectorNeedsAttention,
  connectorSummary,
  defaultConnectorScope,
  filterConnectors,
} from './connector-filter';

const conn = (over: Partial<AdminConnector> = {}): AdminConnector =>
  ({
    slug: 'linear',
    name: 'Linear',
    provider: 'mcp',
    status: 'active',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: false,
    actions: [],
    authSecret: 'LINEAR_TOKEN',
    secretSet: true,
    ...over,
  }) as AdminConnector;

describe('connectorNeedsAttention', () => {
  test('a healthy connected connector is fine', () => {
    expect(connectorNeedsAttention(conn())).toBe(false);
  });
  test('a non-active status needs attention', () => {
    expect(connectorNeedsAttention(conn({ status: 'needs_auth' }))).toBe(true);
    expect(connectorNeedsAttention(conn({ status: 'error' }))).toBe(true);
    expect(connectorNeedsAttention(conn({ status: 'disabled' }))).toBe(true);
  });
  test('a connector that wants a credential but has none needs attention', () => {
    expect(connectorNeedsAttention(conn({ secretSet: false }))).toBe(true);
  });
  test('a connector that needs no credential is fine without one', () => {
    expect(connectorNeedsAttention(conn({ authSecret: null, secretSet: false }))).toBe(false);
  });
});

describe('defaultConnectorScope', () => {
  test('lands on the project list when the project has connectors', () => {
    expect(defaultConnectorScope([conn()])).toBe('project');
  });
  // `connectors_api_discover` is off by default, and the catalog Browse reads
  // is an experimental surface. With no Browse tab to land on, an empty
  // project lands on its own (empty) list, which invites "Add connector".
  test('lands on browse when the project has none and browse is available', () => {
    expect(defaultConnectorScope([], { browseEnabled: true })).toBe('browse');
  });
  test('falls back to the project list when browse is unavailable', () => {
    expect(defaultConnectorScope([], { browseEnabled: false })).toBe('project');
  });
  // Fails CLOSED. Gating an experimental surface must not be something a
  // caller gets by forgetting an argument.
  test('an omitted flag means no browse, not browse', () => {
    expect(defaultConnectorScope([])).toBe('project');
    expect(defaultConnectorScope([], {})).toBe('project');
  });
  test('a project with connectors is unaffected by the browse flag', () => {
    expect(defaultConnectorScope([conn()], { browseEnabled: false })).toBe('project');
  });
});

describe('connectorSummary', () => {
  const actions = (n: number) => Array.from({ length: n }, () => ({})) as AdminConnector['actions'];

  test('reads as tool count then provider', () => {
    expect(connectorSummary(conn({ actions: actions(2) }), 'MCP')).toBe('2 tools · MCP');
  });
  test('one tool is singular', () => {
    expect(connectorSummary(conn({ actions: actions(1) }), 'MCP')).toBe('1 tool · MCP');
  });
  // A connector that has never synced carries no actions. "0 tools" is the
  // honest reading and is itself a signal, so it is not suppressed.
  test('a connector with no synced tools still says so', () => {
    expect(connectorSummary(conn(), 'App')).toBe('0 tools · App');
  });
});

describe('filterConnectors', () => {
  const all = [conn(), conn({ slug: 'gmail', name: 'Gmail', status: 'error' })];

  test('project scope returns every added connector', () => {
    expect(filterConnectors(all, { scope: 'project', query: '' })).toHaveLength(2);
  });
  test('attention scope returns only the unhealthy ones', () => {
    expect(filterConnectors(all, { scope: 'attention', query: '' }).map((c) => c.slug)).toEqual([
      'gmail',
    ]);
  });
  test('query matches name and slug, case-insensitively', () => {
    expect(filterConnectors(all, { scope: 'project', query: 'GMA' }).map((c) => c.slug)).toEqual([
      'gmail',
    ]);
  });
  test('browse scope returns nothing from the added list', () => {
    expect(filterConnectors(all, { scope: 'browse', query: '' })).toHaveLength(0);
  });
});
