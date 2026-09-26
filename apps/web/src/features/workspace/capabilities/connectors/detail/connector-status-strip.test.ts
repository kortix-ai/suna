import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';

import { connectorStatusTiles, policyCountsFromEffective } from './connector-status-strip';

describe('connectorStatusTiles — the connected-state facts', () => {
  test('a project-scoped connector names the shared account and scope', () => {
    const tiles = connectorStatusTiles(
      { toolCount: 52, readCount: 31, usesProjectAuthorization: true },
      testUiTranslator,
    );
    expect(tiles.map((tile) => tile.title)).toEqual(['Active', '52 tools', 'Whole project']);
    expect(tiles[0]?.detail).toBe('Shared project account');
    expect(tiles[2]?.detail).toBe('Everyone uses one shared sign-in.');
  });

  test('destructive tools count as writes — reads vs everything else', () => {
    // 31 reads out of 52 leaves 21 writes, whatever mix of write/destructive
    // the server reported — the same fold `groupToolsByRisk` renders.
    const tiles = connectorStatusTiles(
      { toolCount: 52, readCount: 31, usesProjectAuthorization: true },
      testUiTranslator,
    );
    expect(tiles[1]?.detail).toBe('31 read · 21 write');
  });

  test('a member-scoped connector says whose account carries the session', () => {
    const tiles = connectorStatusTiles(
      { toolCount: 3, readCount: 3, usesProjectAuthorization: false },
      testUiTranslator,
    );
    expect(tiles[0]?.detail).toBe('Your account');
    expect(tiles[2]?.title).toBe('Each member');
    expect(tiles[2]?.detail).toBe('Members connect their own accounts.');
  });

  test('one tool reads as one tool', () => {
    const tiles = connectorStatusTiles(
      { toolCount: 1, readCount: 1, usesProjectAuthorization: true },
      testUiTranslator,
    );
    expect(tiles[1]?.title).toBe('1 tool');
    expect(tiles[1]?.detail).toBe('1 read · 0 write');
  });

  test('with policies readable, the tools tile states what the gate will do', () => {
    const tiles = connectorStatusTiles(
      {
        toolCount: 52,
        readCount: 31,
        usesProjectAuthorization: true,
        policyCounts: { allowed: 49, ask: 2, blocked: 1 },
      },
      testUiTranslator,
    );
    expect(tiles[1]?.title).toBe('52 tools');
    expect(tiles[1]?.detail).toBe('49 allowed · 2 ask · 1 blocked');
  });
});

describe('policyCountsFromEffective', () => {
  test('buckets each resolved tool by the action the gate takes', () => {
    expect(
      policyCountsFromEffective([
        { path: 'a', action: 'always_run', source: 'risk_default' },
        { path: 'b', action: 'always_run', source: 'connector' },
        { path: 'c', action: 'require_approval', source: 'risk_default' },
        { path: 'd', action: 'block', source: 'project' },
      ]),
    ).toEqual({ allowed: 2, ask: 1, blocked: 1 });
  });

  test('an older server with no resolved list yields no counts, not zeros', () => {
    expect(policyCountsFromEffective(undefined)).toBeNull();
    expect(policyCountsFromEffective([])).toBeNull();
  });
});
