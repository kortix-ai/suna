import { describe, expect, test } from 'bun:test';

import {
  applyEnablementToProviderList,
  LLM_PROVIDER_CREDENTIALS,
  type ProviderListResponse,
  connectedGatewayProviderIdsFromSecretNames,
  mergeProviderLists,
  mergeProjectSecretConnectedProviders,
  projectLlmCatalogToProviderList,
} from './provider-selection';

describe('LLM_PROVIDER_CREDENTIALS — Kortix auth requirements, not raw catalog env', () => {
  test('amazon-bedrock requires only the bearer token + region', () => {
    const bedrock = LLM_PROVIDER_CREDENTIALS.find((p) => p.id === 'amazon-bedrock');
    expect(bedrock?.authRequirement.methods).toEqual([
      { envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'], label: 'Bearer token' },
    ]);
  });
});

describe('connectedGatewayProviderIdsFromSecretNames (SDK native-mode path)', () => {
  test('amazon-bedrock connects via bearer token + region alone — the essentia case', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(
      new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']),
    );
    expect(ids.has('amazon-bedrock')).toBe(true);
  });

  test('a bearer token with no region does not connect', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(new Set(['AWS_BEARER_TOKEN_BEDROCK']));
    expect(ids.has('amazon-bedrock')).toBe(false);
  });

  test('the unimplemented SigV4 pair never satisfies Bedrock, even with a region set', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(
      new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION']),
    );
    expect(ids.has('amazon-bedrock')).toBe(false);
  });

  test('a single-secret provider (anthropic) still connects the old way', () => {
    const ids = connectedGatewayProviderIdsFromSecretNames(new Set(['ANTHROPIC_API_KEY']));
    expect(ids.has('anthropic')).toBe(true);
  });
});

describe('mergeProjectSecretConnectedProviders (SDK native-mode provider merge)', () => {
  function bareProviders(ids: string[]): ProviderListResponse {
    return {
      default: {},
      connected: [],
      all: ids.map((id) => ({
        id,
        name: id,
        models: { [`${id}-model`]: { name: `${id} model` } },
      })),
    } as unknown as ProviderListResponse;
  }

  test('marks Bedrock connected from project secrets alone (bearer + region)', () => {
    const merged = mergeProjectSecretConnectedProviders(
      bareProviders(['amazon-bedrock']),
      new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']),
      LLM_PROVIDER_CREDENTIALS,
    );
    expect(merged.connected).toContain('amazon-bedrock');
  });

  test('does not mark Bedrock connected from a partial secret set', () => {
    const merged = mergeProjectSecretConnectedProviders(
      bareProviders(['amazon-bedrock']),
      new Set(['AWS_REGION']),
      LLM_PROVIDER_CREDENTIALS,
    );
    expect(merged.connected).not.toContain('amazon-bedrock');
  });
});

describe('projectLlmCatalogToProviderList', () => {
  test('removes stale auto entries and selects a concrete default', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        auto: { name: 'Auto' },
        'claude-opus-4.8': { name: 'Claude Opus 4.8' },
      },
    } as never);

    expect(list.default).toEqual({ kortix: 'claude-opus-4.8' });
    expect(Object.keys(list.all?.[0]?.models ?? {})).toEqual(['claude-opus-4.8']);
  });
});

describe('mergeProviderLists', () => {
  test('merges providers, connections, and defaults by provider id', () => {
    const primary = {
      default: { kortix: 'managed' },
      connected: ['kortix'],
      all: [{ id: 'kortix', name: 'Kortix', models: {} }],
    } as unknown as ProviderListResponse;
    const secondary = {
      default: { anthropic: 'claude' },
      connected: ['anthropic'],
      all: [{ id: 'anthropic', name: 'Anthropic', models: {} }],
    } as unknown as ProviderListResponse;

    const merged = mergeProviderLists(primary, secondary);

    expect(merged.connected).toEqual(['kortix', 'anthropic']);
    expect(merged.all?.map((provider) => provider.id)).toEqual(['kortix', 'anthropic']);
    expect(merged.default).toEqual({ kortix: 'managed', anthropic: 'claude' });
  });
});

// The session picker renders from the cached gateway ProviderListResponse
// (query ['project-providers', :id, 'gateway'], staleTime Infinity) — NOT from
// the ['project-model-picker'] query the Manage-models tab writes through. A
// toggle must be able to restamp `enabled` on that cached shape optimistically,
// or the open picker keeps showing the pre-toggle list until a hard refresh.
describe('applyEnablementToProviderList', () => {
  const providers = {
    default: { kortix: 'glm-5.2' },
    connected: ['kortix'],
    all: [
      {
        id: 'kortix',
        name: 'Kortix',
        source: 'gateway',
        models: {
          'glm-5.2': { name: 'GLM 5.2', enabled: true },
          'anthropic/claude-sonnet-5': { name: 'Claude Sonnet 5', enabled: true },
        },
      },
    ],
  } as unknown as ProviderListResponse;

  test('restamps enabled only for models named in the overrides', () => {
    const next = applyEnablementToProviderList(providers, {
      'anthropic/claude-sonnet-5': false,
    });
    const models = (next.all?.[0] as { models: Record<string, { enabled?: boolean }> }).models;
    expect(models['anthropic/claude-sonnet-5'].enabled).toBe(false);
    expect(models['glm-5.2'].enabled).toBe(true);
  });

  test('does not mutate the input list', () => {
    applyEnablementToProviderList(providers, { 'glm-5.2': false });
    const models = (providers.all?.[0] as { models: Record<string, { enabled?: boolean }> }).models;
    expect(models['glm-5.2'].enabled).toBe(true);
  });
});
