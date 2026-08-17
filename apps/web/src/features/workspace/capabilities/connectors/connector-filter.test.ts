import type { AdminConnector } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compareConnectors,
  connectorNeedsAttention,
  connectorSummary,
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

describe('the landing tab is Discovery, unconditionally', () => {
  const page = readFileSync(join(import.meta.dir, 'connectors-page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // `defaultConnectorScope(connectors)` opened a project that already had
  // connectors on its own list, which put the least useful tab in front of the
  // user most often — someone opening this page is usually here to ADD a
  // connector, and the ones they have are one click away. It also made the
  // landing tab depend on a query, so the page could settle onto a different
  // tab than it first rendered.
  test('the default scope is a constant, not derived from the project', () => {
    // The scope moved into `?scope=` so Channels could be linked to. The
    // landing tab did not move: an absent or unrecognised param is Discovery,
    // for every project, before any query resolves.
    expect(page).toContain(
      "const scope: ConnectorScope = parseScope(search?.get('scope') ?? null) ?? 'discover';",
    );
    expect(page).not.toContain('defaultConnectorScope');
  });

  test('Discovery writes no param, so the bare page URL stays bare', () => {
    expect(page).toContain(
      "next === 'discover' ? params.delete('scope') : params.set('scope', next),",
    );
  });

  test('the helper is gone rather than left unused', () => {
    const filter = readFileSync(join(import.meta.dir, 'connector-filter.ts'), 'utf8');
    expect(filter).not.toContain('defaultConnectorScope');
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
