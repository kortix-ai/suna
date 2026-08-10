import type { AdminConnector } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { CONNECTOR_TABS, connectorTabs } from './connector-tabs';

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
    authSecret: 'T',
    secretSet: true,
    ...over,
  }) as AdminConnector;

// Order is THE invariant of the tab model, so it is pinned longhand, position
// by position, against literals — never against `CONNECTOR_TABS`, which
// would make the assertion agree with any reordering of the constant.
describe('the canonical tab order', () => {
  test('CONNECTOR_TABS is exactly accounts, tools, settings', () => {
    expect(CONNECTOR_TABS.length).toBe(3);
    expect(CONNECTOR_TABS[0]).toBe('accounts');
    expect(CONNECTOR_TABS[1]).toBe('tools');
    expect(CONNECTOR_TABS[2]).toBe('settings');
  });

  test('a connector that yields all three tabs emits them in that literal sequence', () => {
    const tabs = connectorTabs(conn({ provider: 'pipedream' }), { canWrite: true });
    expect(tabs.length).toBe(3);
    expect(tabs[0]).toBe('accounts');
    expect(tabs[1]).toBe('tools');
    expect(tabs[2]).toBe('settings');
  });
});

describe('connectorTabs', () => {
  test('order is always accounts, tools, settings', () => {
    expect(connectorTabs(conn({ provider: 'pipedream' }), { canWrite: true })).toEqual([
      'accounts',
      'tools',
      'settings',
    ]);
  });

  test('a computer connector with no write access still shows its assigned machines', () => {
    expect(connectorTabs(conn({ provider: 'computer' }), { canWrite: false })).toEqual([
      'accounts',
    ]);
  });

  test('a read-only viewer sees no tools or settings tab', () => {
    const tabs = connectorTabs(conn(), { canWrite: false });
    expect(tabs).not.toContain('tools');
    expect(tabs).not.toContain('settings');
  });

  test('a computer profile keeps regular profile settings', () => {
    expect(connectorTabs(conn({ provider: 'computer' }), { canWrite: true })).toContain('settings');
  });

  test('channel connectors keep settings for their channel connection form', () => {
    expect(connectorTabs(conn({ provider: 'channel' }), { canWrite: true })).toContain('settings');
  });

  test('a non-pipedream connector still gets accounts for its shared credential', () => {
    expect(connectorTabs(conn({ provider: 'mcp' }), { canWrite: true })).toContain('accounts');
  });

  test('a writer on a computer connector gets all regular connector tabs', () => {
    expect(connectorTabs(conn({ provider: 'computer' }), { canWrite: true })).toEqual([
      'accounts',
      'tools',
      'settings',
    ]);
  });

  test('a read-only viewer gets exactly accounts', () => {
    expect(connectorTabs(conn(), { canWrite: false })).toEqual(['accounts']);
  });

  // The whole point of the tab model: a tab that does not apply is ABSENT,
  // but the tabs that remain never trade places. Any output must therefore be
  // a subsequence of the canonical order — this pins that for every reachable
  // combination of the three inputs the function reads, not just the eight
  // cases spelled out above.
  test('every provider × permission combination is a subsequence of the canonical order', () => {
    const providers: AdminConnector['provider'][] = [
      'pipedream',
      'mcp',
      'openapi',
      'postman',
      'graphql',
      'http',
      'channel',
      'computer',
    ];
    for (const provider of providers) {
      for (const canWrite of [true, false]) {
        for (const authorizationStrategy of ['project', 'user'] as const) {
          const tabs = connectorTabs(conn({ provider, authorizationStrategy }), { canWrite });
          const positions = tabs.map((tab) => CONNECTOR_TABS.indexOf(tab));
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          expect(positions).not.toContain(-1);
          expect(new Set(tabs).size).toBe(tabs.length);
        }
      }
    }
  });
});
