import { describe, expect, test } from 'bun:test';

import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
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
