import { describe, expect, test } from 'bun:test';

import type { ProviderListResponse } from '@kortix/sdk/react';
import { flattenModels } from './model-flatten';

// `provider` must survive from the API catalog (`GatewayModel.provider`)
// through the SDK response type (`GatewayCatalogModel.provider`) to
// `FlatModel.provider`. It used to be recovered with an `(model as any)` cast
// because the SDK response type never declared the field; these assertions
// pin the DECLARED path.
function gatewayProviders(models: Record<string, unknown>): ProviderListResponse {
  return {
    default: { kortix: 'auto' },
    connected: ['kortix'],
    all: [{ id: 'kortix', name: 'Kortix', source: 'gateway', models }],
  } as unknown as ProviderListResponse;
}

describe('flattenModels — gateway provider pass-through', () => {
  test('carries `provider` for a dot-namespaced BYOK Bedrock model', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'us.anthropic.claude-opus-4-8': {
          name: 'Claude Opus 4.8',
          provider: 'amazon-bedrock',
        },
      }),
    );
    expect(flat.provider).toBe('amazon-bedrock');
    expect(flat.providerID).toBe('kortix');
    expect(flat.providerName).toBe('Kortix');
  });

  test('names a BYOK model after its real provider (OpenCode Go, not "Kortix")', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'opencode-go/glm-5.3': { name: 'GLM-5.3', provider: 'opencode-go', provider_name: 'OpenCode Go' },
      }),
    );
    expect(flat.providerID).toBe('kortix');
    expect(flat.providerName).toBe('OpenCode Go');
  });

  test('carries the models.dev passthrough fields', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'deepseek.v3.2': {
          name: 'DeepSeek V3.2',
          provider: 'amazon-bedrock',
          release_date: '2026-01-15',
          family: 'deepseek',
          description: 'A model.',
          open_weights: true,
          last_updated: '2026-07-01',
          free: true,
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'] },
          limit: { context: 128000, output: 8192 },
          cost: { input: 1, output: 2 },
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        },
      }),
    );
    expect(flat.releaseDate).toBe('2026-01-15');
    expect(flat.family).toBe('deepseek');
    expect(flat.description).toBe('A model.');
    expect(flat.openWeights).toBe(true);
    expect(flat.lastUpdated).toBe('2026-07-01');
    expect(flat.free).toBe(true);
    expect(flat.contextWindow).toBe(128000);
    expect(flat.cost).toEqual({ input: 1, output: 2 });
    expect(flat.capabilities).toEqual({ reasoning: true, vision: true, toolcall: true });
    expect(flat.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high'] }]);
  });

  test('leaves `provider` undefined for a stale catalog that predates the field', () => {
    const [flat] = flattenModels(
      gatewayProviders({ 'us.anthropic.claude-opus-4-8': { name: 'Claude Opus 4.8' } }),
    );
    expect(flat.provider).toBeUndefined();
  });

  test('skips providers that are not connected', () => {
    expect(
      flattenModels({
        default: {},
        connected: [],
        all: [{ id: 'kortix', name: 'Kortix', source: 'gateway', models: { a: { name: 'A' } } }],
      } as unknown as ProviderListResponse),
    ).toEqual([]);
  });

  test('reads capabilities off the canonical opencode `Model` shape when present', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'gpt-5.6': {
          name: 'GPT-5.6',
          capabilities: { reasoning: true, toolcall: false, input: { image: true } },
        },
      }),
    );
    expect(flat.capabilities).toEqual({ reasoning: true, vision: true, toolcall: false });
  });
});

// Characterization (KRTX-452, phase 1 of KRTX-451): pins the host copy where
// it still drifts from the canonical SDK flattener
// (packages/sdk/src/core/models/model-flatten.ts). The SDK twin of this file
// pins the same fixtures on the SDK side. Later phases reconcile the host
// onto the SDK semantics; rewrite these assertions then, deliberately, inside
// the reconciliation PR — never as a quiet drive-by.
describe('flattenModels — host drift vs @kortix/sdk (characterization)', () => {
  const driftProviders = {
    default: {},
    connected: ['kortix', 'anthropic'],
    all: [
      {
        id: 'kortix',
        name: 'Kortix',
        source: 'gateway',
        models: {
          // A catalog silent on modalities, in both wire shapes.
          'custom/mystery': { name: 'Mystery' },
          'custom/silent': { name: 'Silent', capabilities: { reasoning: true } },
          // Zero-cost managed model: the gateway stamps `free`.
          'kortix/free-tier': { name: 'Free Tier', free: true, cost: { input: 0, output: 0 } },
          'kortix/paid-tier': { name: 'Paid Tier', cost: { input: 1, output: 2 } },
          // Stale pre-removal entries a baked catalog can still carry.
          auto: { name: 'Auto' },
          'kortix/auto': { name: 'Kortix Auto' },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'env',
        models: { 'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6' } },
      },
    ],
  } as unknown as ProviderListResponse;

  function byModelID(flat: ReturnType<typeof flattenModels>) {
    return new Map(flat.map((m) => [m.modelID, m]));
  }

  test('no provider-mode filter: connected native providers flatten next to the gateway provider', () => {
    const flat = flattenModels(driftProviders);
    // The SDK drops `anthropic` in gateway mode and `kortix` in native mode;
    // the host has no provider-mode filter at all and keeps both.
    expect(new Set(flat.map((m) => m.providerID))).toEqual(new Set(['kortix', 'anthropic']));
  });

  test('a catalog silent on modalities pins vision to false — the SDK leaves it undefined', () => {
    const byId = byModelID(flattenModels(driftProviders));
    expect(byId.get('custom/mystery')?.capabilities?.vision).toBe(false);
    expect(byId.get('custom/silent')?.capabilities?.vision).toBe(false);
  });

  test('stale auto/kortix/auto entries are NOT dropped — the SDK drops them', () => {
    const byId = byModelID(flattenModels(driftProviders));
    expect(byId.has('auto')).toBe(true);
    expect(byId.has('kortix/auto')).toBe(true);
  });

  test('free pins to a boolean: true on a zero-cost model, false when the catalog is silent', () => {
    const byId = byModelID(flattenModels(driftProviders));
    expect(byId.get('kortix/free-tier')?.free).toBe(true);
    expect(byId.get('kortix/paid-tier')?.free).toBe(false);
  });
});
