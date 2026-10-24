import type { AdminConnector } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  compareConnectors,
  connectorNeedsAttention,
  connectorSummary,
  filterConnectors,
  parseConnectorScope,
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
    expect(connectorSummary(conn(), 'Composio')).toBe('0 tools · Composio');
  });
});

describe('compareConnectors', () => {
  const healthy = conn({ slug: 'asana', name: 'Asana' });
  const broken = conn({ slug: 'zoom', name: 'Zoom', status: 'error' });

  // The whole reason the Needs-attention tab could be deleted: the signal it
  // carried survives as position. If this stops holding, a broken connector
  // sinks to the bottom of a long list and the tab has to come back.
  test('anything needing attention sorts before anything healthy', () => {
    expect([healthy, broken].sort(compareConnectors).map((c) => c.slug)).toEqual(['zoom', 'asana']);
  });
  test('two connectors in the same state sort by display name', () => {
    const linear = conn({ slug: 'a', name: 'Linear' });
    const gmail = conn({ slug: 'b', name: 'Gmail' });
    expect([linear, gmail].sort(compareConnectors).map((c) => c.name)).toEqual(['Gmail', 'Linear']);
  });
  // `connectorDisplayName` falls back to the slug, so a nameless connector
  // still has something to sort on rather than collapsing to ''.
  test('a connector with no name sorts on its slug', () => {
    const named = conn({ slug: 'a', name: 'Zoom' });
    const nameless = conn({ slug: 'gmail', name: '' });
    expect([named, nameless].sort(compareConnectors).map((c) => c.slug)).toEqual(['gmail', 'a']);
  });
});

describe('filterConnectors', () => {
  const all = [conn(), conn({ slug: 'gmail', name: 'Gmail', status: 'error' })];

  // There is no `scope` any more — this list is only ever the project's own
  // connectors, and it is never partitioned.
  test('returns every added connector, healthy or not', () => {
    expect(filterConnectors(all, { query: '' })).toHaveLength(2);
  });
  test('orders by compareConnectors, not by input order', () => {
    expect(filterConnectors(all, { query: '' }).map((c) => c.slug)).toEqual(['gmail', 'linear']);
  });
  test('query matches name and slug, case-insensitively', () => {
    expect(filterConnectors(all, { query: 'GMA' }).map((c) => c.slug)).toEqual(['gmail']);
  });
  test('query matches the description the card actually shows', () => {
    const describe_ = (c: AdminConnector) => connectorSummary(c, 'OpenAPI');
    expect(filterConnectors(all, { query: 'openapi', describe: describe_ })).toHaveLength(2);
  });
  test('does not mutate the caller’s array', () => {
    const input = [...all];
    filterConnectors(input, { query: '' });
    expect(input.map((c) => c.slug)).toEqual(['linear', 'gmail']);
  });
});

describe('parseConnectorScope', () => {
  const parse = (query: string) => parseConnectorScope(new URLSearchParams(query));
  test('no param lands on the project connectors', () => {
    expect(parse('')).toBe('connectors');
    expect(parse('scope=nonsense')).toBe('connectors');
  });
  test('each tab is its own value', () => {
    expect(parse('scope=browse')).toBe('browse');
    expect(parse('scope=channels')).toBe('channels');
    expect(parse('scope=rules')).toBe('rules');
  });
  test('old links still land on the right tab', () => {
    expect(parse('scope=all')).toBe('browse');
    expect(parse('scope=connected')).toBe('connectors');
    expect(parse('rules=1')).toBe('rules');
  });
});

test('an API setup_url names the tab as tab=', () => {
  expect(parseConnectorScope(new URLSearchParams('tab=browse&custom=1'))).toBe('browse');
});
