import { describe, expect, test } from 'bun:test';

import { flattenModels } from './model-flatten';
import type { ProviderListResponse } from './use-runtime-sessions';

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
