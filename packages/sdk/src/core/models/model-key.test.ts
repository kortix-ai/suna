import { describe, expect, test } from 'bun:test';
import { flattenModels } from './model-flatten';
import { modelRefToKey } from './model-key';

describe('modelRefToKey', () => {
  test('gateway on: a stored ref is a gateway wire id under the kortix provider, with or without the kortix/ prefix', () => {
    expect(modelRefToKey('glm-5.3-flash', true)).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
    expect(modelRefToKey('kortix/glm-5.3-flash', true)).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
    expect(modelRefToKey('kortix/codex/gpt-5.6-sol', true)).toEqual({ providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' });
    expect(modelRefToKey('anthropic/claude-sonnet-4-6', true)).toEqual({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' });
  });

  test('gateway off: a stored ref is the native provider/model, split on the first slash', () => {
    expect(modelRefToKey('openrouter/z-ai/glm-4.7-flash', false)).toEqual({ providerID: 'openrouter', modelID: 'z-ai/glm-4.7-flash' });
    expect(modelRefToKey('kortix/anthropic/claude-sonnet-4-6', false)).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  });

  test('gateway off: a ref with no provider falls back to the gateway shape (renders unset, never throws)', () => {
    expect(modelRefToKey('glm-5.3-flash', false)).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
  });
});

describe('flattenModels ids', () => {
  test('every flattened model carries its stored ref as `id`', () => {
    const providers = {
      all: [
        { id: 'kortix', name: 'Kortix', models: { 'glm-5.3-flash': { name: 'GLM' }, 'anthropic/claude': { name: 'Claude' } } },
        { id: 'openrouter', name: 'OpenRouter', models: { 'z-ai/glm': { name: 'GLM' } } },
      ],
      connected: ['kortix', 'openrouter'],
      default: {},
    } as never;
    expect(flattenModels(providers).map((m) => m.id)).toEqual(['glm-5.3-flash', 'anthropic/claude']);
    expect(flattenModels(providers, { providerMode: 'native' }).map((m) => m.id)).toEqual(['openrouter/z-ai/glm']);
  });
});
