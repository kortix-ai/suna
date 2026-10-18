import { describe, expect, test } from 'bun:test';

import { flattenModels } from './model-flatten';

/** A gateway `/model-picker` list: the synthetic `kortix` provider whose models
 *  carry the loose models.dev-ish shape (no `capabilities`). */
function gatewayList(models: Record<string, unknown>, name = 'Kortix') {
  return {
    all: [{ id: 'kortix', name, source: 'gateway', models }],
    connected: ['kortix'],
    default: {},
  };
}

describe('flattenModels · the gateway loose-shape projection', () => {
  // The synthetic provider's models are NOT opencode `Model` values: they carry
  // the flatter gateway shape (`provider`, `provider_name`, `reasoning_options`,
  // `modalities`, `free`, ...). This pins the projection field-for-field —
  // `hasCapabilities` must take the loose branch and read those keys.
  test('a gateway model projects every loose field onto the FlatModel record', () => {
    const list = gatewayList({
      'anthropic/claude-opus-4-8': {
        id: 'anthropic/claude-opus-4-8',
        name: 'Claude Opus 4.8 (latest)',
        provider: 'anthropic',
        provider_name: 'OpenCode Go',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 32_000 },
        release_date: '2026-09-01',
        family: 'opus',
        cost: { input: 3, output: 15 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        description: 'The big one.',
        open_weights: false,
        last_updated: '2026-09-02',
        enabled: true,
        free: false,
      },
    });
    const flat = flattenModels(list);
    expect(flat).toHaveLength(1);
    const model = flat[0]!;
    // A gateway model's wire id is the bare modelID (the kortix provider is implied).
    expect(model.id).toBe('anthropic/claude-opus-4-8');
    expect(model.providerID).toBe('kortix');
    expect(model.providerName).toBe('OpenCode Go');
    expect(model.modelID).toBe('anthropic/claude-opus-4-8');
    // The display name loses the models.dev `(latest)` suffix.
    expect(model.modelName).toBe('Claude Opus 4.8');
    expect(model.capabilities).toEqual({ reasoning: true, vision: true, toolcall: true });
    expect(model.contextWindow).toBe(200_000);
    expect(model.releaseDate).toBe('2026-09-01');
    expect(model.family).toBe('opus');
    expect(model.cost).toEqual({ input: 3, output: 15 });
    expect(model.provider).toBe('anthropic');
    expect(model.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high'] }]);
    expect(model.description).toBe('The big one.');
    expect(model.openWeights).toBe(false);
    expect(model.lastUpdated).toBe('2026-09-02');
    expect(model.enabled).toBe(true);
    expect(model.free).toBe(false);
  });

  test('the opencode-native shape (with capabilities) projects through the same function', () => {
    const list = gatewayList({
      'kortix/auto': { name: 'Auto' },
      'x-ai/grok-5': {
        name: 'Grok 5',
        capabilities: { reasoning: true, toolcall: true, input: { image: true } },
        limit: { context: 1_000_000 },
        cost: { input: 1, output: 2 },
      },
    });
    const flat = flattenModels(list);
    // Stale baked `auto` entries never surface.
    expect(flat).toHaveLength(1);
    expect(flat[0]!.modelID).toBe('x-ai/grok-5');
    expect(flat[0]!.capabilities).toEqual({ reasoning: true, vision: true, toolcall: true });
    expect(flat[0]!.providerName).toBe('Kortix');
    expect(flat[0]!.provider).toBeUndefined();
  });

  test('a catalog silent about modalities keeps vision undefined, and free is exact', () => {
    const list = gatewayList({
      'a/one': { name: 'One', reasoning: true, tool_call: true },
      'a/two': { name: 'Two', free: 'yes' },
    });
    const flat = flattenModels(list);
    expect(flat[0]!.capabilities!.vision).toBeUndefined();
    expect(flat[1]!.free).toBe(false);
  });

  test('native mode drops a stale gateway entry; gateway mode drops a native one', () => {
    const staleKortix = gatewayList({ 'a/one': { name: 'One' } });
    expect(flattenModels(staleKortix, { providerMode: 'native' })).toHaveLength(0);
    expect(flattenModels(staleKortix, { providerMode: 'gateway' })).toHaveLength(1);
    const native = gatewayList({ 'a/one': { name: 'One' } });
    native.all[0]!.id = 'openrouter';
    native.connected = ['openrouter'];
    expect(flattenModels(native, { providerMode: 'native' })).toHaveLength(1);
    expect(flattenModels(native, { providerMode: 'gateway' })).toHaveLength(0);
  });
});
