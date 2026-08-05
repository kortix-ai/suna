import type { AdminConnector } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { CONNECTOR_RUNG_ORDER, visibleRungs } from './connector-rungs';

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

// Order is THE invariant of the rung model, so it is pinned longhand, position
// by position, against literals — never against `CONNECTOR_RUNG_ORDER`, which
// would make the assertion agree with any reordering of the constant.
describe('the canonical rung order', () => {
  test('CONNECTOR_RUNG_ORDER is exactly accounts, permissions, settings', () => {
    expect(CONNECTOR_RUNG_ORDER.length).toBe(3);
    expect(CONNECTOR_RUNG_ORDER[0]).toBe('accounts');
    expect(CONNECTOR_RUNG_ORDER[1]).toBe('permissions');
    expect(CONNECTOR_RUNG_ORDER[2]).toBe('settings');
  });

  test('a connector that yields all three rungs emits them in that literal sequence', () => {
    const rungs = visibleRungs(conn({ provider: 'pipedream' }), { canWrite: true });
    expect(rungs.length).toBe(3);
    expect(rungs[0]).toBe('accounts');
    expect(rungs[1]).toBe('permissions');
    expect(rungs[2]).toBe('settings');
  });
});

describe('visibleRungs', () => {
  test('order is always accounts, permissions, settings', () => {
    expect(visibleRungs(conn({ provider: 'pipedream' }), { canWrite: true })).toEqual([
      'accounts',
      'permissions',
      'settings',
    ]);
  });

  test('a computer connector with no write access has no rungs', () => {
    expect(visibleRungs(conn({ provider: 'computer' }), { canWrite: false })).toEqual([]);
  });

  test('a read-only viewer sees no permissions or settings rung', () => {
    const rungs = visibleRungs(conn(), { canWrite: false });
    expect(rungs).not.toContain('permissions');
    expect(rungs).not.toContain('settings');
  });

  test('computer connectors are managed in Computers — no settings rung', () => {
    expect(visibleRungs(conn({ provider: 'computer' }), { canWrite: true })).not.toContain(
      'settings',
    );
  });

  test('channel connectors keep settings for their channel connection form', () => {
    expect(visibleRungs(conn({ provider: 'channel' }), { canWrite: true })).toContain('settings');
  });

  test('a non-pipedream connector still gets accounts for its shared credential', () => {
    expect(visibleRungs(conn({ provider: 'mcp' }), { canWrite: true })).toContain('accounts');
  });

  test('a writer on a computer connector gets exactly permissions', () => {
    expect(visibleRungs(conn({ provider: 'computer' }), { canWrite: true })).toEqual([
      'permissions',
    ]);
  });

  test('a read-only viewer gets exactly accounts', () => {
    expect(visibleRungs(conn(), { canWrite: false })).toEqual(['accounts']);
  });

  // The whole point of the rung model: a rung that does not apply is ABSENT,
  // but the rungs that remain never trade places. Any output must therefore be
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
          const rungs = visibleRungs(conn({ provider, authorizationStrategy }), { canWrite });
          const positions = rungs.map((rung) => CONNECTOR_RUNG_ORDER.indexOf(rung));
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          expect(positions).not.toContain(-1);
          expect(new Set(rungs).size).toBe(rungs.length);
        }
      }
    }
  });
});
