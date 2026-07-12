import { describe, expect, test } from 'bun:test';

import {
  connectedGatewayProviderIdsFromSecretNames,
  filterToGatewayProviders,
  filterToNativeProviders,
  mergeProjectSecretConnectedProviders,
  mergeProviderLists,
  normalizeProviderList,
  projectLlmCatalogToProviderList,
  providerListHasGateway,
  providerListHasModels,
  type ProviderListResponse,
} from './provider-selection';

function providers(ids: string[]): ProviderListResponse {
  return {
    default: {},
    connected: ids,
    all: ids.map((id) => ({
      id,
      name: id,
      models: {
        [`${id}-model`]: { name: `${id} model` },
      },
    })),
  } as ProviderListResponse;
}

describe('provider-selection', () => {
  test('detects usable connected provider models', () => {
    expect(providerListHasModels(providers(['anthropic']))).toBe(true);
    expect(providerListHasModels({ default: {}, connected: [], all: [] } as ProviderListResponse)).toBe(false);
  });

  test('normalizes v0.9.68 native provider responses for the model picker', () => {
    const legacy = {
      default: { opencode: 'deepseek-v4-flash-free' },
      providers: [{
        id: 'opencode',
        name: 'Runtime Zen',
        models: {
          'deepseek-v4-flash-free': { name: 'DeepSeek V4 Flash Free' },
        },
      }],
    } as unknown as ProviderListResponse;

    const normalized = normalizeProviderList(legacy);
    expect(normalized.connected).toEqual(['opencode']);
    expect(normalized.all?.map((p) => p.id)).toEqual(['opencode']);
    expect(providerListHasModels(legacy)).toBe(true);
    expect(filterToNativeProviders(legacy).connected).toEqual(['opencode']);
  });

  test('keeps gateway providers only when the running runtime exposes kortix', () => {
    const mixed = providers(['kortix', 'opencode', 'anthropic']);
    expect(providerListHasGateway(mixed)).toBe(true);
    expect(filterToGatewayProviders(mixed).connected).toEqual(['kortix']);
    expect(filterToGatewayProviders(mixed).all?.map((p) => p.id)).toEqual(['kortix']);

    const native = providers(['anthropic', 'openai']);
    expect(providerListHasGateway(native)).toBe(false);
    expect(native.connected).toEqual(['anthropic', 'openai']);
  });

  test('removes stale gateway provider when project is in native mode', () => {
    const mixed = providers(['kortix', 'opencode', 'anthropic']);
    const native = filterToNativeProviders(mixed);
    expect(native.connected).toEqual(['opencode', 'anthropic']);
    expect(native.all?.map((p) => p.id)).toEqual(['opencode', 'anthropic']);
  });

  test('marks native project-secret providers connected even when Runtime connected is stale', () => {
    const merged = mergeProjectSecretConnectedProviders(
      {
        default: {},
        connected: ['opencode'],
        all: [
          { id: 'opencode', name: 'Runtime Zen', models: { zen: { name: 'Zen' } } },
          { id: 'anthropic', name: 'Anthropic', models: { claude: { name: 'Claude' } } },
        ],
      } as unknown as ProviderListResponse,
      new Set(['ANTHROPIC_API_KEY']),
      [{ id: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] }],
    );

    expect(merged.connected).toEqual(['opencode', 'anthropic']);
    expect(providerListHasModels(merged)).toBe(true);
  });

  test('maps ChatGPT subscription secrets to the codex gateway provider', () => {
    expect(
      [...connectedGatewayProviderIdsFromSecretNames(new Set(['CODEX_AUTH_JSON']))],
    ).toEqual(['codex']);
    expect(
      [...connectedGatewayProviderIdsFromSecretNames(new Set(['OPENCODE_AUTH_JSON']))],
    ).toEqual(['codex']);
  });

  test('converts the project catalog into the managed kortix provider', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        auto: { name: 'Auto' },
        'claude-opus-4.8': { name: 'Claude Opus 4.8' },
      },
    });

    expect(list.connected).toEqual(['kortix']);
    expect(list.default).toEqual({ kortix: 'auto' });
    expect(list.all?.[0]?.id).toBe('kortix');
    expect(Object.keys(list.all?.[0]?.models ?? {})).toEqual(['auto', 'claude-opus-4.8']);
    expect((list.all?.[0]?.models as any)?.['deepseek-v4-flash-free']).toBeUndefined();
  });

  test('does not invent a kortix/auto default for an empty project catalog', () => {
    const list = projectLlmCatalogToProviderList({ models: {} });

    expect(list.connected).toEqual(['kortix']);
    expect(list.default).toEqual({});
    expect(list.all?.[0]?.models).toEqual({});
  });

  test('does not merge session-native providers into gateway catalog', () => {
    const project = projectLlmCatalogToProviderList({
      models: {
        auto: { name: 'Auto' },
      },
    });
    const session = filterToGatewayProviders(providers(['opencode', 'anthropic']));
    const merged = mergeProviderLists(project, session);

    expect(merged.connected).toEqual(['kortix']);
    expect(merged.all?.map((p) => p.id)).toEqual(['kortix']);
    expect(merged.all?.find((p) => p.id === 'opencode')).toBeUndefined();
  });
});
