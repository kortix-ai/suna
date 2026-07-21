import { describe, expect, test } from 'bun:test';
import {
  boundSessionAgentName,
  buildComposerOptions,
  capFeedModels,
  presetToFlatModel,
  resolvePresetProviderId,
} from './composer-chat-input';

describe('harness-aware composer options', () => {
  test('locks an existing session to its persisted logical agent', () => {
    expect(boundSessionAgentName('  claude  ')).toBe('claude');
    expect(boundSessionAgentName(null)).toBeNull();
  });

  for (const harness of ['claude', 'codex', 'pi'] as const) {
    test(`${harness} sends the agent without a stale gateway model override`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
        }),
      ).toEqual({ agent: harness });
    });
  }

  for (const harness of ['claude', 'codex', 'pi'] as const) {
    test(`${harness} carries an explicit harness-native model without a gateway model key`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'stale/model' },
          runtimeModel: ' native/model ',
        }),
      ).toEqual({
        agent: harness,
        runtimeModel: 'native/model',
        modelSelection: {
          kind: 'custom',
          modelId: 'native/model',
          connectionId: null,
        },
      });
    });
  }

  test('OpenCode retains the selected catalog model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      }),
    ).toEqual({
      agent: 'kortix',
      model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      modelSelection: {
        kind: 'custom',
        modelId: 'kortix/openai/gpt-5.4',
        connectionId: null,
      },
    });
  });

  test('OpenCode ignores a stale harness-native model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        runtimeModel: 'native/model',
      }),
    ).toEqual({ agent: 'kortix' });
  });
});

// Regression coverage for the "providerID mis-tag" bug: a project routed
// through `anthropic_api_key` returned 6 real, `can_start: true` presets with
// BARE ids (no `/` — see `modelPresets()` in
// apps/api/src/projects/lib/composer-capabilities.ts), but the picker showed
// "No models available" because the bare id's `providerID` defaulted to the
// HARNESS name (`opencode`) instead of the real upstream provider
// (`anthropic`) that main's `ModelSelector` filters visibility against (see
// `connectedGatewayProviderIdsFromSecretNames`).
describe('resolvePresetProviderId', () => {
  test('the server-stamped `provider` field (verified live: every modelPresets() branch sets it) always wins', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'claude-sonnet-5',
        presetProvider: 'anthropic',
        connectionKind: null,
        harnessFallback: 'opencode',
      }),
    ).toBe('anthropic');
  });

  test('a bare anthropic_api_key preset id with no `provider` field resolves to the real provider, never the harness', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'claude-sonnet-5',
        connectionKind: 'anthropic_api_key',
        harnessFallback: 'opencode',
      }),
    ).toBe('anthropic');
  });

  test('a bare openai_api_key preset id resolves to openai', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'gpt-5.4',
        connectionKind: 'openai_api_key',
        harnessFallback: 'opencode',
      }),
    ).toBe('openai');
  });

  test('a namespaced preset id (managed_gateway/native_config) splits on "/" regardless of connection kind', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'kortix/auto',
        connectionKind: 'managed_gateway',
        harnessFallback: 'opencode',
      }),
    ).toBe('kortix');
    expect(
      resolvePresetProviderId({
        presetId: 'anthropic/claude-sonnet-5',
        connectionKind: 'native_config',
        harnessFallback: 'claude',
      }),
    ).toBe('anthropic');
  });

  test('a bare id under a connection kind with no known real-provider mapping falls back to the harness', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'custom-model',
        connectionKind: 'openai_compatible',
        harnessFallback: 'pi',
      }),
    ).toBe('pi');
    expect(
      resolvePresetProviderId({ presetId: 'claude-sonnet-4-6', connectionKind: null, harnessFallback: 'claude' }),
    ).toBe('claude');
  });
});

describe('presetToFlatModel', () => {
  test('reads the real project bafd5d7c-7fac-4e5c-a274-db73c5da4e39 shape returned live by the running dev API: opencode routed through anthropic_api_key, 6 stamped presets', () => {
    // Captured live from apps/api/src/projects/lib/composer-capabilities.ts's
    // `modelPresets('anthropic_api_key', ...)` against this dev stack.
    const model = presetToFlatModel(
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', source: 'models.dev', provider: 'anthropic' },
      { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
    );
    expect(model.providerID).toBe('anthropic');
    expect(model.modelID).toBe('claude-sonnet-5');
  });

  test('tags a bare anthropic_api_key preset as the real provider and carries catalog release metadata, even with no `provider` field (pre-refactor API shape)', () => {
    const model = presetToFlatModel(
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', source: 'models.dev' },
      { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
    );
    expect(model.providerID).toBe('anthropic');
    expect(model.modelID).toBe('claude-sonnet-5');
    expect(model.modelName).toBe('Claude Sonnet 5');
    // Real catalog entry — released/family should be populated (not asserting
    // exact values so this doesn't churn every catalog refresh).
    expect(model.releaseDate).toBeTruthy();
  });

  test('a kortix-namespaced preset skips the catalog lookup (gateway ids are not models.dev ids)', () => {
    const model = presetToFlatModel(
      { id: 'kortix/auto', name: 'Auto', source: 'kortix-gateway' },
      { connectionKind: 'managed_gateway', harnessFallback: 'opencode' },
    );
    expect(model.providerID).toBe('kortix');
    expect(model.modelID).toBe('auto');
    expect(model.releaseDate).toBeUndefined();
  });
});

// Regression coverage for the "4,941-model uncapped render lag" bug: a
// `managed_gateway` preset list is the gateway's entire routable catalog: it
// must stay capped at the feeding layer since main's `ModelSelector` has no
// cap of its own.
describe('capFeedModels', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: `model-${i}`,
    modelName: `Model ${i}`,
  }));

  test('passes a list under the cap through unchanged', () => {
    expect(capFeedModels(many.slice(0, 10), null, 50)).toHaveLength(10);
  });

  test('caps a huge list to the given size', () => {
    expect(capFeedModels(many, null, 50)).toHaveLength(50);
  });

  test('the selected model is always present, even past the cap', () => {
    const selected = { providerID: 'anthropic', modelID: 'model-199' };
    const result = capFeedModels(many, selected, 50);
    expect(result).toHaveLength(51);
    expect(result.some((m) => m.providerID === 'anthropic' && m.modelID === 'model-199')).toBe(true);
  });

  test('a selected model already within the cap is not duplicated', () => {
    const selected = { providerID: 'anthropic', modelID: 'model-0' };
    expect(capFeedModels(many, selected, 50)).toHaveLength(50);
  });
});
