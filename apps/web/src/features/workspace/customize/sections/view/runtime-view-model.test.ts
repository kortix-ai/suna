import { describe, expect, test } from 'bun:test';

import type { ModelsPageRuntime } from '@kortix/sdk/react';

import {
  buildRuntimeRows,
  connectionsByHarnessFromModelsPage,
} from './runtime-view-model';

function modelsPageRuntime(over: Partial<ModelsPageRuntime> & Pick<ModelsPageRuntime, 'harness'>): ModelsPageRuntime {
  return {
    id: over.harness,
    label: over.harness,
    status: 'missing',
    selectedConnectionId: null,
    modelSummary: null,
    compatibleConnectionIds: [],
    blocker: null,
    ...over,
  };
}

describe('connectionsByHarnessFromModelsPage', () => {
  test('keys the runtime list by harness id', () => {
    const map = connectionsByHarnessFromModelsPage([
      modelsPageRuntime({ harness: 'claude', status: 'ready' }),
      modelsPageRuntime({ harness: 'codex', status: 'missing' }),
    ]);
    expect(map.claude?.status).toBe('ready');
    expect(map.codex?.status).toBe('missing');
    expect(map.opencode).toBeUndefined();
  });

  test('empty input yields an empty map', () => {
    expect(connectionsByHarnessFromModelsPage([])).toEqual({});
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
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.profileName)).toEqual(['claude', 'runtime-2']);
  });

  test('label comes from the canonical harness descriptor, not the profile name', () => {
    const rows = buildRuntimeRows({ 'my-custom-slug': { harness: 'claude' } }, {});
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
      {
        claude: modelsPageRuntime({
          harness: 'claude',
          status: 'ready',
          selectedConnectionId: 'claude_subscription',
        }),
      },
    );
    expect(rows[0]!.connected).toBe(true);
    expect(rows[0]!.meta).toBe('Runs Claude Code · Connected via Claude subscription');
  });

  test('a missing/unready connection reads "Not connected" — no jargon connection-kind ids', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' } },
      { claude: modelsPageRuntime({ harness: 'claude', status: 'missing' }) },
    );
    expect(rows[0]!.connected).toBe(false);
    expect(rows[0]!.meta).toBe('Runs Claude Code · Not connected');
  });

  test('a harness with no entry in the connection map defaults to not connected', () => {
    const rows = buildRuntimeRows({ pi: { harness: 'pi' } }, {});
    expect(rows[0]!.connected).toBe(false);
    expect(rows[0]!.meta).toBe('Runs Pi · Not connected');
  });

  test('no row ever contains manifest jargon (schema_version, kortix.yaml, config-dir paths)', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude', config_dir: '.claude' } },
      {
        claude: modelsPageRuntime({
          harness: 'claude',
          status: 'ready',
          selectedConnectionId: 'claude_subscription',
        }),
      },
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('schema_version');
    expect(serialized).not.toContain('kortix.yaml');
    expect(serialized).not.toContain('kortix.toml');
    expect(serialized).not.toContain('.claude');
  });
});
