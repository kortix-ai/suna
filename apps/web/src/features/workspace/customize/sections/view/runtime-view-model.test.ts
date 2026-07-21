import { describe, expect, test } from 'bun:test';

import type { ModelsPageConnection } from '@kortix/sdk/react';

import {
  buildRuntimeRows,
  connectedHarnessesFromModelsPage,
} from './runtime-view-model';

function modelsPageConnection(
  over: Partial<ModelsPageConnection> & Pick<ModelsPageConnection, 'kind'>,
): ModelsPageConnection {
  return {
    id: over.kind,
    name: over.kind,
    status: 'ready',
    usedBy: [],
    catalogState: 'available',
    modelCount: null,
    statusReason: null,
    ...over,
  };
}

describe('connectedHarnessesFromModelsPage', () => {
  test('keys ready connections by every harness the auth kind is compatible with', () => {
    const map = connectedHarnessesFromModelsPage([
      modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
      modelsPageConnection({ kind: 'codex_subscription', status: 'needs-attention' }),
    ]);
    expect(map.claude?.kind).toBe('claude_subscription');
    // Not ready — must not count as connected.
    expect(map.codex).toBeUndefined();
    expect(map.opencode).toBeUndefined();
  });

  test('a managed_gateway connection is compatible with opencode and pi, not claude/codex', () => {
    const map = connectedHarnessesFromModelsPage([
      modelsPageConnection({ kind: 'managed_gateway', status: 'ready' }),
    ]);
    expect(map.opencode?.kind).toBe('managed_gateway');
    expect(map.pi?.kind).toBe('managed_gateway');
    expect(map.claude).toBeUndefined();
    expect(map.codex).toBeUndefined();
  });

  test('empty input yields an empty map', () => {
    expect(connectedHarnessesFromModelsPage([])).toEqual({});
  });

  test('a ready connection with zero routed agents still counts as connected — the fix for the '
    + 'agent-presence-gating bug (WS5-P2-a review): unlike `useModelsPage(...).runtimes`, which is '
    + 'derived from declared agents and omits any harness with none currently routed, `connections` '
    + 'carries no such gate', () => {
    // No `ModelsPageRuntime` entries exist for `claude` at all here (that
    // list is what the old, buggy derivation read) — only a bare ready
    // connection, which is all a harness needs to be genuinely connected.
    const map = connectedHarnessesFromModelsPage([
      modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
    ]);
    expect(map.claude?.status).toBe('ready');
  });
});

describe('buildRuntimeRows', () => {
  test('one row per declared runtime profile, keyed by profile name', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude', config_dir: '.claude' },
        'runtime-2': { harness: 'opencode' },
      },
      {},
      true,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.profileName)).toEqual(['claude', 'runtime-2']);
  });

  test('label comes from the canonical harness descriptor, not the profile name', () => {
    const rows = buildRuntimeRows({ 'my-custom-slug': { harness: 'claude' } }, {}, true);
    expect(rows[0]!.label).toBe('Claude Code');
    expect(rows[0]!.label).not.toContain('my-custom-slug');
  });

  test('claude/codex/pi are experimental, opencode is stable', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude' },
        codex: { harness: 'codex' },
        opencode: { harness: 'opencode' },
        pi: { harness: 'pi' },
      },
      {},
      true,
    );
    const experimentalByHarness = Object.fromEntries(rows.map((r) => [r.harness, r.experimental]));
    expect(experimentalByHarness).toEqual({
      claude: true,
      codex: true,
      opencode: false,
      pi: true,
    });
  });

  test('a ready connection produces a plain-words "Connected via …" meta line and connected: true', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' } },
      connectedHarnessesFromModelsPage([
        modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
      ]),
      true,
    );
    expect(rows[0]!.connected).toBe(true);
    expect(rows[0]!.meta).toBe('Runs Claude Code · Connected via Claude subscription');
  });

  test('a missing/unready connection reads "Not connected" — no jargon connection-kind ids', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' } },
      connectedHarnessesFromModelsPage([
        modelsPageConnection({ kind: 'claude_subscription', status: 'needs-attention' }),
      ]),
      true,
    );
    expect(rows[0]!.connected).toBe(false);
    expect(rows[0]!.meta).toBe('Runs Claude Code · Not connected');
  });

  test('a harness with no entry in the connection map defaults to not connected', () => {
    const rows = buildRuntimeRows({ pi: { harness: 'pi' } }, {}, true);
    expect(rows[0]!.connected).toBe(false);
    expect(rows[0]!.meta).toBe('Runs Pi · Not connected');
  });

  test(
    'a harness with a ready compatible connection but zero routed agents still reads Connected — ' +
      'regression test for the WS5-P2-a review Important finding: the badge must not be gated on ' +
      'agent presence',
    () => {
      const rows = buildRuntimeRows(
        { claude: { harness: 'claude' } },
        connectedHarnessesFromModelsPage([
          // Simulates the real-world "just enabled harnesses, no agent
          // routed yet" state: a ready connection exists, no agent routing
          // data backs it.
          modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
        ]),
        true,
      );
      expect(rows[0]!.connected).toBe(true);
      expect(rows[0]!.meta).toBe('Runs Claude Code · Connected via Claude subscription');
    },
  );

  test('no row ever contains manifest jargon (schema_version, kortix.yaml, config-dir paths)', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude', config_dir: '.claude' } },
      connectedHarnessesFromModelsPage([
        modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
      ]),
      true,
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('schema_version');
    expect(serialized).not.toContain('kortix.yaml');
    expect(serialized).not.toContain('kortix.toml');
    expect(serialized).not.toContain('.claude');
  });

  // ─── OpenCode-first: filter experimental rows when the flag is off ───────

  test('experimentalHarnessesEnabled=false filters out claude/codex/pi rows, keeps opencode', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude' },
        codex: { harness: 'codex' },
        opencode: { harness: 'opencode' },
        pi: { harness: 'pi' },
      },
      {},
      false,
    );
    expect(rows.map((r) => r.harness)).toEqual(['opencode']);
  });

  test('experimentalHarnessesEnabled=true keeps every row, including experimental ones', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude' },
        opencode: { harness: 'opencode' },
      },
      {},
      true,
    );
    expect(rows.map((r) => r.harness)).toEqual(['claude', 'opencode']);
    expect(rows.find((r) => r.harness === 'claude')!.experimental).toBe(true);
  });

  test('a runtimes map with only experimental harnesses and the flag off yields zero rows', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' }, codex: { harness: 'codex' } },
      {},
      false,
    );
    expect(rows).toEqual([]);
  });
});
