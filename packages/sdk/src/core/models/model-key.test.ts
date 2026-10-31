import { describe, expect, test } from 'bun:test';
import { flattenModels } from './model-flatten';
import { modelRefToKey } from './model-key';
import { projectLlmCatalogToProviderList } from './provider-selection';

describe('modelRefToKey', () => {
  test('gateway on: a stored ref is a gateway wire id under the kortix provider, with or without the kortix/ prefix', () => {
    expect(modelRefToKey('glm-5.3-flash', true)).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
    expect(modelRefToKey('kortix/glm-5.3-flash', true)).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
    expect(modelRefToKey('kortix/codex/gpt-5.6-sol', true)).toEqual({ providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' });
    expect(modelRefToKey('anthropic/claude-sonnet-4-6', true)).toEqual({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' });
  });

  test('the gateway is the only model path: the deprecated second argument changes nothing', () => {
    expect(modelRefToKey('openrouter/z-ai/glm-4.7-flash', false)).toEqual({ providerID: 'kortix', modelID: 'openrouter/z-ai/glm-4.7-flash' });
    expect(modelRefToKey('kortix/anthropic/claude-sonnet-4-6', false)).toEqual({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' });
    expect(modelRefToKey('glm-5.3-flash')).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
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
    // `providerMode: 'native'` is deprecated: the gateway is the only model path.
    expect(flattenModels(providers, { providerMode: 'native' }).map((m) => m.id)).toEqual(['glm-5.3-flash', 'anthropic/claude']);
  });
});

describe('Claude subscription models', () => {
  test('a stored claude-agent/<id> ref is the claude-agent provider, not a gateway wire id', () => {
    expect(modelRefToKey('claude-agent/opus')).toEqual({ providerID: 'claude-agent', modelID: 'opus' });
    expect(modelRefToKey('kortix/claude-agent/sonnet')).toEqual({ providerID: 'claude-agent', modelID: 'sonnet' });
  });

  test('the picker catalog lists the Claude group beside the gateway models, runnable only once the caller connected Claude', () => {
    const catalog = (connected: boolean) => ({
      models: { 'glm-5.3-flash': { name: 'GLM' } },
      claudeSubscription: {
        providerId: 'claude-agent',
        name: 'Claude subscription',
        connected,
        models: [{ id: 'claude-agent/opus', name: 'Claude Opus 5.5', description: 'Best for everyday, complex tasks', limit: { context: 1_000_000, output: 64_000 }, efforts: ['low', 'high'], requires: 'claude_subscription' as const, connected }],
      },
    }) as never;
    const off = flattenModels(projectLlmCatalogToProviderList(catalog(false)));
    const claude = off.find((m) => m.providerID === 'claude-agent');
    expect(off.map((m) => m.id)).toEqual(['glm-5.3-flash', 'claude-agent/opus']);
    expect(claude).toMatchObject({ modelID: 'opus', modelName: 'Claude Opus 5.5', providerName: 'Claude subscription', provider: 'claude-agent', available: false, availability: 'login', contextWindow: 1_000_000 });
    expect(Object.keys(claude?.variants ?? {})).toEqual(['low', 'high']);
    const on = flattenModels(projectLlmCatalogToProviderList(catalog(true)));
    expect(on.find((m) => m.providerID === 'claude-agent')?.available).toBe(true);
    // A catalog without the group (an older API) lists only the gateway models.
    expect(flattenModels(projectLlmCatalogToProviderList({ models: { 'glm-5.3-flash': { name: 'GLM' } } } as never)).map((m) => m.id)).toEqual(['glm-5.3-flash']);
  });
});
