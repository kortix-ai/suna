import { describe, expect, test } from 'bun:test';
import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';

import {
  buildHarnessConnections,
  computeDefaultAllowed,
  isExperimentalHarnessGated,
  modelPresets,
  newestCatalogModels,
  readHarnessAuthRoutes,
  resolveActiveHarnessConnection,
  writeHarnessAuthRoute,
} from './composer-capabilities';

describe('composer capability auth resolution', () => {
  test('keeps Claude subscription and Anthropic API key as separate connections', () => {
    const connections = buildHarnessConnections({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
        ANTHROPIC_API_KEY: 'api-key',
      },
      gatewayEnabled: false,
    });
    expect(connections.find((item) => item.id === 'claude_subscription')?.ready).toBe(true);
    expect(connections.find((item) => item.id === 'anthropic_api_key')?.ready).toBe(true);
    expect(connections.find((item) => item.id === 'codex_subscription')?.ready).toBe(false);
  });

  test('keeps Codex subscription and OpenAI API key as separate connections', () => {
    const connections = buildHarnessConnections({
      env: { CODEX_AUTH_JSON: '{}', OPENAI_API_KEY: 'api-key' },
      gatewayEnabled: false,
    });
    expect(connections.find((item) => item.id === 'codex_subscription')?.ready).toBe(true);
    expect(connections.find((item) => item.id === 'openai_api_key')?.ready).toBe(true);
  });

  test('managed gateway is the deterministic default for opencode/pi until an explicit route is stored', () => {
    const connections = buildHarnessConnections({
      env: { ANTHROPIC_API_KEY: 'api-key' },
      gatewayEnabled: true,
    });
    expect(resolveActiveHarnessConnection({ harness: 'opencode', connections }).active?.id).toBe('managed_gateway');
    expect(resolveActiveHarnessConnection({ harness: 'pi', connections }).active?.id).toBe('managed_gateway');
    expect(resolveActiveHarnessConnection({
      harness: 'opencode',
      connections,
      explicit: 'anthropic_api_key',
    }).active?.id).toBe('anthropic_api_key');
  });

  test('2026-07-15 simplification: claude and codex are harness-only, never the managed gateway or a custom endpoint', () => {
    const connections = buildHarnessConnections({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'subscription', CODEX_AUTH_JSON: '{}' },
      gatewayEnabled: true,
    });
    // Even with the gateway enabled, claude/codex resolve to their own
    // subscription — the gateway is not in their compatible set at all.
    expect(resolveActiveHarnessConnection({ harness: 'claude', connections }).active?.id).toBe('claude_subscription');
    expect(resolveActiveHarnessConnection({ harness: 'codex', connections }).active?.id).toBe('codex_subscription');
    expect(resolveActiveHarnessConnection({
      harness: 'claude',
      connections,
      explicit: 'managed_gateway',
    }).active).toBeNull();
    expect(resolveActiveHarnessConnection({
      harness: 'codex',
      connections,
      explicit: 'openai_compatible',
    }).active).toBeNull();
  });

  test('per-harness compatible connection kinds match the 2026-07-15 simplification matrix', () => {
    const connections = buildHarnessConnections({ env: {}, gatewayEnabled: false });
    const kindsFor = (harness: 'claude' | 'codex' | 'opencode' | 'pi') =>
      connections
        .filter((connection) => connection.compatible_harnesses.includes(harness))
        .map((connection) => connection.id)
        .sort();

    expect(kindsFor('claude')).toEqual(['anthropic_api_key', 'claude_subscription', 'native_config']);
    expect(kindsFor('codex')).toEqual(['codex_subscription', 'native_config', 'openai_api_key']);
    expect(kindsFor('opencode')).toEqual([
      'anthropic_api_key',
      'managed_gateway',
      'native_config',
      'openai_api_key',
      'openai_compatible',
    ]);
    expect(kindsFor('pi')).toEqual([
      'anthropic_api_key',
      'managed_gateway',
      'native_config',
      'openai_api_key',
      'openai_compatible',
    ]);
    expect(connections.find((connection) => connection.id === 'anthropic_compatible')?.compatible_harnesses).toEqual(
      [],
    );
  });

  test('two native credentials require an explicit choice when the gateway is disabled', () => {
    const connections = buildHarnessConnections({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'subscription', ANTHROPIC_API_KEY: 'api-key' },
      gatewayEnabled: false,
    });
    const result = resolveActiveHarnessConnection({ harness: 'claude', connections });
    expect(result.active).toBeNull();
    expect(result.reason).toContain('Choose');
  });

  test('native config is not ready merely because a runtime has a conventional directory', () => {
    const missing = buildHarnessConnections({
      env: {},
      gatewayEnabled: false,
    });
    expect(missing.find((item) => item.id === 'native_config')).toMatchObject({
      configured: false,
      ready: false,
    });

    const present = buildHarnessConnections({
      env: {},
      gatewayEnabled: false,
      nativeConfigReady: true,
    });
    expect(present.find((item) => item.id === 'native_config')).toMatchObject({
      configured: true,
      ready: true,
    });
  });

  test('active bindings round-trip without disturbing other project metadata', () => {
    const metadata = writeHarnessAuthRoute({ existing: true }, 'codex', 'codex_subscription');
    expect(readHarnessAuthRoutes(metadata)).toEqual({ codex: 'codex_subscription' });
    expect(metadata.existing).toBe(true);
    expect(readHarnessAuthRoutes(writeHarnessAuthRoute(metadata, 'codex', null))).toEqual({});
  });
});

describe('isExperimentalHarnessGated (WS2-P1-b: experimental_harnesses selection gate)', () => {
  test('opencode (the only stable harness) is NEVER gated, flag off or on', () => {
    expect(isExperimentalHarnessGated('opencode', {})).toBe(false);
    expect(isExperimentalHarnessGated('opencode', { experimental: { experimental_harnesses: true } })).toBe(false);
    expect(isExperimentalHarnessGated('opencode', { experimental: { experimental_harnesses: false } })).toBe(false);
  });

  test('every non-stable harness (claude/codex/pi today) is gated when the flag is off', () => {
    for (const id of HARNESS_IDS) {
      if (HARNESSES[id].stability === 'stable') continue;
      expect(isExperimentalHarnessGated(id, {})).toBe(true);
      expect(isExperimentalHarnessGated(id, { experimental: { experimental_harnesses: false } })).toBe(true);
    }
  });

  test('every non-stable harness is un-gated once the project opts in', () => {
    for (const id of HARNESS_IDS) {
      if (HARNESSES[id].stability === 'stable') continue;
      expect(isExperimentalHarnessGated(id, { experimental: { experimental_harnesses: true } })).toBe(false);
    }
  });
});

describe('computeDefaultAllowed', () => {
  test('no active connection never has a usable default', () => {
    expect(computeDefaultAllowed({ active: null, harness: 'opencode', presetsLength: 0 })).toBe(false);
    expect(computeDefaultAllowed({ active: null, harness: 'claude', presetsLength: 0 })).toBe(false);
  });

  test('Claude/Codex/Pi always own their default natively, regardless of presets', () => {
    for (const harness of ['claude', 'codex', 'pi'] as const) {
      expect(
        computeDefaultAllowed({ active: 'claude_subscription', harness, presetsLength: 0 }),
      ).toBe(true);
    }
  });

  test('OpenCode with a non-empty preset catalog has a usable default', () => {
    expect(
      computeDefaultAllowed({ active: 'anthropic_api_key', harness: 'opencode', presetsLength: 3 }),
    ).toBe(true);
  });

  test('OpenCode on a ready native config has a usable default even with an empty catalog', () => {
    expect(
      computeDefaultAllowed({ active: 'native_config', harness: 'opencode', presetsLength: 0 }),
    ).toBe(true);
  });

  test('OpenCode on a ready managed gateway has a usable default (managed-auto) even with an empty catalog', () => {
    expect(
      computeDefaultAllowed({ active: 'managed_gateway', harness: 'opencode', presetsLength: 0 }),
    ).toBe(true);
  });

  test('OpenCode on a non-managed, non-native connection with no presets requires an explicit model', () => {
    expect(
      computeDefaultAllowed({ active: 'openai_compatible', harness: 'opencode', presetsLength: 0 }),
    ).toBe(false);
  });
});

describe('newestCatalogModels', () => {
  test('keeps only the newest N by release date, newest first', () => {
    const models = [
      { id: 'a', name: 'A', released: '2024-01-01' },
      { id: 'b', name: 'B', released: '2026-01-01' },
      { id: 'c', name: 'C', released: '2025-01-01' },
    ];
    expect(newestCatalogModels(models, 2).map((m) => m.id)).toEqual(['b', 'c']);
  });

  test('ties on release date break deterministically by id', () => {
    const models = [
      { id: 'z', name: 'Z', released: '2026-01-01' },
      { id: 'a', name: 'A', released: '2026-01-01' },
    ];
    expect(newestCatalogModels(models, 2).map((m) => m.id)).toEqual(['a', 'z']);
  });

  test('models with no release date sort last', () => {
    const models = [
      { id: 'undated', name: 'Undated' },
      { id: 'dated', name: 'Dated', released: '2020-01-01' },
    ];
    expect(newestCatalogModels(models, 2).map((m) => m.id)).toEqual(['dated', 'undated']);
  });
});

describe('modelPresets curated native catalogs', () => {
  test('anthropic_api_key preset list is capped to the newest 6 models.dev entries', () => {
    const presets = modelPresets('anthropic_api_key', {}, 'test-project');
    expect(presets.length).toBeLessThanOrEqual(6);
    expect(presets.length).toBeGreaterThan(0);
  });

  test('openai_api_key preset list is capped to the newest 6 models.dev entries', () => {
    const presets = modelPresets('openai_api_key', {}, 'test-project');
    expect(presets.length).toBeLessThanOrEqual(6);
    expect(presets.length).toBeGreaterThan(0);
  });
});
