import { describe, expect, test } from 'bun:test';

import { flattenModels, isOfferedModel, type FlatModel } from './model-flatten';
import type { ProviderListResponse } from './use-opencode-sessions';

// Regression coverage for the "every provider shows as Kortix" picker bug:
// the gateway exposes its ENTIRE catalog under one synthetic `kortix`
// opencode provider. `flattenModels` must carry the model's REAL upstream
// `provider` field (and `reasoningOptions`) through onto `FlatModel` so
// downstream grouping/gating never has to recover them by string-splitting
// the wire model id — see model-selector.tsx's `pickerGroupId`.
function gatewayProviderList(
  models: Record<string, Record<string, unknown>>,
): ProviderListResponse {
  return {
    connected: ['kortix'],
    all: [{ id: 'kortix', name: 'Kortix', source: 'custom', models }],
  } as unknown as ProviderListResponse;
}

describe('flattenModels — gateway `provider` + `reasoning_options` pass-through', () => {
  test('carries the explicit `provider` field for a BYOK model registered under the kortix provider', () => {
    const [flat] = flattenModels(
      gatewayProviderList({
        'anthropic/claude-opus-4-8': {
          name: 'Claude Opus 4.8',
          provider: 'anthropic',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
        },
      }),
    );
    expect(flat?.providerID).toBe('kortix');
    expect(flat?.provider).toBe('anthropic');
    expect(flat?.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }]);
  });

  test('carries `provider: "kortix"` for a managed model, distinct from its providerID', () => {
    const [flat] = flattenModels(
      gatewayProviderList({
        'claude-opus-4.8': { name: 'Claude Opus 4.8', provider: 'kortix', reasoning: true },
      }),
    );
    expect(flat?.provider).toBe('kortix');
  });

  test('carries `provider: "codex"` for a ChatGPT-subscription model, distinct from raw `openai`', () => {
    const [flat] = flattenModels(
      gatewayProviderList({
        'codex/gpt-5.6-sol': { name: 'GPT-5.6 Sol (ChatGPT)', provider: 'codex', reasoning: true },
      }),
    );
    expect(flat?.provider).toBe('codex');
  });

  test('a model with two embedded slashes still resolves via the explicit field, not string-splitting', () => {
    // e.g. models.dev's own id can itself contain a "/" (mixlayer/qwen/qwen3.5-9b) —
    // the explicit `provider` field sidesteps any ambiguity about where to split.
    const [flat] = flattenModels(
      gatewayProviderList({
        'mixlayer/qwen/qwen3.5-9b': { name: 'Qwen3.5 9B', provider: 'mixlayer', reasoning: false },
      }),
    );
    expect(flat?.provider).toBe('mixlayer');
    expect(flat?.modelID).toBe('mixlayer/qwen/qwen3.5-9b');
  });

  test('`provider` and `reasoningOptions` are undefined for a stale/older catalog entry without them', () => {
    const [flat] = flattenModels(
      gatewayProviderList({
        'anthropic/claude-legacy': { name: 'Claude Legacy', reasoning: false },
      }),
    );
    expect(flat?.provider).toBeUndefined();
    expect(flat?.reasoningOptions).toBeUndefined();
  });

  // MUST-FIX regression (adversarial review of PR #5010): description,
  // open_weights, and last_updated used to stop at LlmProviderModel/
  // GatewayModel and never reach FlatModel — silently dropped on the last
  // hop despite being threaded everywhere upstream.
  test('carries description/openWeights/lastUpdated through onto FlatModel', () => {
    const [flat] = flattenModels(
      gatewayProviderList({
        'anthropic/claude-opus-4-8': {
          name: 'Claude Opus 4.8',
          provider: 'anthropic',
          description: 'Most capable Claude model',
          open_weights: false,
          last_updated: '2026-05-28',
        },
      }),
    );
    expect(flat?.description).toBe('Most capable Claude model');
    expect(flat?.openWeights).toBe(false);
    expect(flat?.lastUpdated).toBe('2026-05-28');
  });

  // A `reasoning_options` entry with no `values` (the budget_tokens/toggle
  // shapes) must round-trip too — not just the `effort` shape's array.
  test('carries a budget_tokens-shaped reasoning_options entry through verbatim', () => {
    const [flat] = flattenModels(
      gatewayProviderList({
        'anthropic/claude-haiku-4-5': {
          name: 'Claude Haiku 4.5',
          provider: 'anthropic',
          reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        },
      }),
    );
    expect(flat?.reasoningOptions).toEqual([{ type: 'budget_tokens', min: 1024 }]);
  });
});

// Native mode (project `llm_gateway` flag OFF): the session runtime serves
// OpenCode's own connected providers (`anthropic`, `openrouter`, `opencode`,
// …) and the synthetic `kortix` provider does not exist. `flattenModels` must
// flatten those — the gateway-only allowlist applies only in gateway mode, or
// the composer has ZERO models off-gateway and refuses to send.
describe('flattenModels — native mode (llm_gateway off)', () => {
  const nativeList = {
    connected: ['anthropic', 'opencode'],
    all: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'env',
        models: {
          'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', reasoning: true, tool_call: true },
        },
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        source: 'custom',
        models: { 'big-pickle': { name: 'Big Pickle' } },
      },
      // A disconnected provider must not flatten even in native mode.
      { id: 'openai', name: 'OpenAI', source: 'env', models: { 'gpt-5.2': { name: 'GPT-5.2' } } },
    ],
  } as unknown as ProviderListResponse;

  test('native mode flattens connected native providers', () => {
    const flat = flattenModels(nativeList, { providerMode: 'native' });
    expect(flat.map((m) => `${m.providerID}/${m.modelID}`).sort()).toEqual([
      'anthropic/claude-sonnet-4-6',
      'opencode/big-pickle',
    ]);
  });

  test('native mode still never renders the synthetic kortix provider', () => {
    const withStaleKortix = {
      connected: ['anthropic', 'kortix'],
      all: [
        ...(nativeList.all ?? []),
        { id: 'kortix', name: 'Kortix', source: 'custom', models: { 'glm-5.3-flash': { name: 'GLM' } } },
      ],
    } as unknown as ProviderListResponse;
    const flat = flattenModels(withStaleKortix, { providerMode: 'native' });
    expect(flat.some((m) => m.providerID === 'kortix')).toBe(false);
    expect(flat.some((m) => m.providerID === 'anthropic')).toBe(true);
  });

  test('default (gateway) mode still drops native providers entirely', () => {
    expect(flattenModels(nativeList)).toEqual([]);
  });
});

// `enabled` is the server's per-project enablement answer (`/model-picker`).
// Every consumer that asks "may this key be offered/resolved?" must go through
// isOfferedModel — a second, client-local visibility heuristic is exactly what
// made the picker and "Manage models" disagree (#5932 half-revert).
describe('isOfferedModel', () => {
  const models = [
    { providerID: 'kortix', modelID: 'anthropic/claude-fable-5', enabled: true },
    { providerID: 'kortix', modelID: 'anthropic/claude-opus-4-1', enabled: false },
    { providerID: 'kortix', modelID: 'glm-5.3-flash' },
  ] as FlatModel[];

  test('offers a model the server enabled', () => {
    expect(isOfferedModel(models, { providerID: 'kortix', modelID: 'anthropic/claude-fable-5' })).toBe(
      true,
    );
  });

  test('refuses a model the server disabled', () => {
    expect(
      isOfferedModel(models, { providerID: 'kortix', modelID: 'anthropic/claude-opus-4-1' }),
    ).toBe(false);
  });

  test('offers a model from a catalog that carries no enablement at all', () => {
    // Native/legacy catalogs never stamp `enabled`; absence means "not
    // applicable", never "hidden".
    expect(isOfferedModel(models, { providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBe(true);
  });

  test('refuses a key that is not in the catalog', () => {
    expect(isOfferedModel(models, { providerID: 'kortix', modelID: 'gone/model' })).toBe(false);
  });
});
