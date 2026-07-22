import { describe, expect, test } from 'bun:test';

import {
  type HarnessAuthKind,
  buildHarnessConnections,
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
    expect(resolveActiveHarnessConnection({ harness: 'opencode', connections }).active?.id).toBe(
      'managed_gateway',
    );
    expect(resolveActiveHarnessConnection({ harness: 'pi', connections }).active?.id).toBe(
      'managed_gateway',
    );
    expect(
      resolveActiveHarnessConnection({
        harness: 'opencode',
        connections,
        explicit: 'anthropic_api_key',
      }).active?.id,
    ).toBe('anthropic_api_key');
  });

  test('2026-07-15 simplification: claude and codex are harness-only, never the managed gateway or a custom endpoint', () => {
    const connections = buildHarnessConnections({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'subscription', CODEX_AUTH_JSON: '{}' },
      gatewayEnabled: true,
    });
    // Even with the gateway enabled, claude/codex resolve to their own
    // subscription — the gateway is not in their compatible set at all.
    expect(resolveActiveHarnessConnection({ harness: 'claude', connections }).active?.id).toBe(
      'claude_subscription',
    );
    expect(resolveActiveHarnessConnection({ harness: 'codex', connections }).active?.id).toBe(
      'codex_subscription',
    );
    expect(
      resolveActiveHarnessConnection({
        harness: 'claude',
        connections,
        explicit: 'managed_gateway',
      }).active,
    ).toBeNull();
    expect(
      resolveActiveHarnessConnection({
        harness: 'codex',
        connections,
        explicit: 'openai_compatible',
      }).active,
    ).toBeNull();
  });

  test('per-harness compatible connection kinds match the 2026-07-15 simplification matrix', () => {
    const connections = buildHarnessConnections({ env: {}, gatewayEnabled: false });
    const kindsFor = (harness: 'claude' | 'codex' | 'opencode' | 'pi') =>
      connections
        .filter((connection) => connection.compatible_harnesses.includes(harness))
        .map((connection) => connection.id)
        .sort();

    expect(kindsFor('claude')).toEqual([
      'anthropic_api_key',
      'claude_subscription',
      'native_config',
    ]);
    expect(kindsFor('codex')).toEqual(['codex_subscription', 'native_config', 'openai_api_key']);
    expect(kindsFor('opencode')).toEqual([
      'anthropic_api_key',
      'managed_gateway',
      'native_config',
      'openai_api_key',
      'openai_compatible',
    ]);
    // 2026-07-22 Codex-subscription widening: Pi gains codex_subscription (it
    // speaks OpenAI Responses natively and the credential relays server-side —
    // docs/specs/2026-07-21-llm-credential-and-model-management.md D1). The
    // sorted set therefore includes codex_subscription; every other pi kind is
    // unchanged.
    expect(kindsFor('pi')).toEqual([
      'anthropic_api_key',
      'codex_subscription',
      'managed_gateway',
      'native_config',
      'openai_api_key',
      'openai_compatible',
    ]);
    expect(
      connections.find((connection) => connection.id === 'anthropic_compatible')
        ?.compatible_harnesses,
    ).toEqual([]);
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

// WS2-P4-a — explicit pins on the founder auth decisions (2026-07-15),
// worded so a future descriptor/CONNECTIONS edit that relaxes the law fails a
// test that names the decision, not just an incidental assertion elsewhere.
// This deliberately overlaps the WS2-P1-a descriptor-conformance coverage
// above ('2026-07-15 simplification: ...', 'per-harness compatible
// connection kinds match ...') — that's by design (see WS2-P4-a brief): those
// tests prove the api matches the descriptor; these prove the founder
// decision itself, independent of whether the descriptor happens to agree.
describe('founder decision 2026-07-15 pins (WS2-P4-a): claude/codex harness-only, opencode/pi keep the gateway, anthropic_compatible parked', () => {
  test('founder decision 2026-07-15: claude/codex are harness-access only — NO managed_gateway, NO openai_compatible, NO anthropic_compatible in their compatible kinds', () => {
    const connections = buildHarnessConnections({ env: {}, gatewayEnabled: false });
    const forbidden: HarnessAuthKind[] = [
      'managed_gateway',
      'openai_compatible',
      'anthropic_compatible',
    ];
    for (const harness of ['claude', 'codex'] as const) {
      const compatibleKinds = connections
        .filter((connection) => connection.compatible_harnesses.includes(harness))
        .map((connection) => connection.id);
      for (const kind of forbidden) {
        expect(compatibleKinds).not.toContain(kind);
      }
    }
  });

  test('founder decision 2026-07-15: anthropic_compatible is parked — compatible_harnesses is EMPTY, but the kind still exists (not deleted from the connections table or the type union)', () => {
    const connections = buildHarnessConnections({ env: {}, gatewayEnabled: false });
    const anthropicCompatible = connections.find(
      (connection) => connection.id === 'anthropic_compatible',
    );
    expect(anthropicCompatible).toBeDefined();
    expect(anthropicCompatible?.compatible_harnesses).toEqual([]);
    // Type-level pin: this assignment only compiles while 'anthropic_compatible'
    // remains a member of the HarnessAuthKind union. If a future change deletes
    // the kind outright (rather than just emptying its compatible_harnesses),
    // this line fails `tsc --noEmit`, not just a runtime assertion.
    const stillInUnion: HarnessAuthKind = 'anthropic_compatible';
    expect(stillInUnion).toBe('anthropic_compatible');
  });

  test('founder decision 2026-07-15: opencode/pi retain the full gateway story — managed_gateway AND openai_compatible stay compatible with both', () => {
    const connections = buildHarnessConnections({ env: {}, gatewayEnabled: false });
    const required: HarnessAuthKind[] = ['managed_gateway', 'openai_compatible'];
    for (const harness of ['opencode', 'pi'] as const) {
      const compatibleKinds = connections
        .filter((connection) => connection.compatible_harnesses.includes(harness))
        .map((connection) => connection.id);
      for (const kind of required) {
        expect(compatibleKinds).toContain(kind);
      }
    }
  });
});

// 2026-07-22: multi-harness selection/start gating is deleted outright
// (`isExperimentalHarnessGated` no longer exists — see
// `composer-capabilities-harness-availability.test.ts` for production-path
// coverage proving every declared harness's `can_start` now depends only on
// its own auth/model resolution, never on a feature flag).

// 2026-07-21 model-resolution refactor (phase 1, docs/specs/2026-07-21-
// model-resolution-refactor-plan.md): `computeDefaultAllowed` and
// `managedGatewayHasNothingToRouteTo` — and their test suites that used to
// live here — are DELETED, not just moved. The closed `state` union they
// approximated with two independent booleans (`default_allowed`/
// `noManagedRoute`, reconciled with `&&`) is now computed in exactly one
// place: `resolveHarnessModels` (`llm-gateway/resolution/harness-models.ts`),
// whose own suite (`harness-models.test.ts`) covers every state × harness-
// kind × credential-health combination those two functions used to split
// across two files. Nothing in `composer-capabilities.ts` recomputes any
// part of that answer anymore — verified below by import-shape assertions
// (a `tsc --noEmit` failure, not just a runtime one, is the real guard: see
// `composer-capabilities.ts`'s import list).
describe('kill list (phase 1): computeDefaultAllowed / managedGatewayHasNothingToRouteTo no longer exist here', () => {
  test('composer-capabilities.ts does not export either killed function', async () => {
    const mod = await import('./composer-capabilities');
    expect((mod as Record<string, unknown>).computeDefaultAllowed).toBeUndefined();
    expect((mod as Record<string, unknown>).managedGatewayHasNothingToRouteTo).toBeUndefined();
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
