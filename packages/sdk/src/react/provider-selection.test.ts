import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { CATALOG, providerAuthRequirement } from '@kortix/llm-catalog';

import {
  applyEnablementToProviderList,
  LLM_PROVIDER_CREDENTIALS,
  type ProviderListResponse,
  connectedGatewayProviderIdsFromSecretNames,
  mergeProviderLists,
  mergeProjectSecretConnectedProviders,
  projectLlmCatalogToProviderList,
} from './provider-selection';

describe('LLM_PROVIDER_CREDENTIALS — built without the full catalog snapshot', () => {
  // Every browser route imports this module (useRuntimeProviders). Reading
  // `CATALOG` here shipped the ~7.6 MB models.dev snapshot to every page.
  test('provider-selection.ts does not import CATALOG', () => {
    const source = readFileSync(new URL('./provider-selection.ts', import.meta.url), 'utf8');
    const catalogImport = source.match(/import \{([^}]*)\} from '@kortix\/llm-catalog'/)?.[1] ?? '';
    expect(catalogImport.split(',').map((name) => name.trim())).not.toContain('CATALOG');
  });

  test('covers every catalog provider with its Kortix auth requirement', () => {
    expect(LLM_PROVIDER_CREDENTIALS).toEqual(
      CATALOG.providers.map((provider) => ({
        id: provider.id,
        authRequirement: providerAuthRequirement(provider),
      })),
    );
  });
});

describe('LLM_PROVIDER_CREDENTIALS — Kortix auth requirements, not raw catalog env', () => {
  test('amazon-bedrock requires only the bearer token + region', () => {
    const bedrock = LLM_PROVIDER_CREDENTIALS.find((p) => p.id === 'amazon-bedrock');
    expect(bedrock?.authRequirement.methods).toEqual([
      { envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'], label: 'Bearer token' },
    ]);
  });
});

describe('connectedGatewayProviderIdsFromSecretNames', () => {
  test('amazon-bedrock connects via bearer token + region alone — the sampleco case', () => {
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

describe('mergeProjectSecretConnectedProviders', () => {
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
// the `qk.project.modelPicker(id)` query the Manage-models tab writes through. A
// toggle must be able to restamp `enabled` on that cached shape optimistically,
// or the open picker keeps showing the pre-toggle list until a hard refresh.
describe('applyEnablementToProviderList', () => {
  const providers = {
    default: { kortix: 'glm-5.3-flash' },
    connected: ['kortix'],
    all: [
      {
        id: 'kortix',
        name: 'Kortix',
        source: 'gateway',
        models: {
          'glm-5.3-flash': { name: 'GLM 5.3 Flash', enabled: true },
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
    expect(models['glm-5.3-flash'].enabled).toBe(true);
  });

  test('does not mutate the input list', () => {
    applyEnablementToProviderList(providers, { 'glm-5.3-flash': false });
    const models = (providers.all?.[0] as { models: Record<string, { enabled?: boolean }> }).models;
    expect(models['glm-5.3-flash'].enabled).toBe(true);
  });
});

describe('projectLlmCatalogToProviderList — variants for the gateway picker', () => {
  test('a gateway model with an effort ladder gets one variant id per published tier, in order', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        'amazon-bedrock/global.openai.gpt-5.6-sol': {
          name: 'GPT-5.6 Sol (Global)',
          reasoning: true,
          reasoning_options: [
            { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
          ],
        },
      },
    });
    const kortix = (list.all ?? []).find((p) => p.id === 'kortix')!;
    const model = kortix.models['amazon-bedrock/global.openai.gpt-5.6-sol'] as {
      variants?: Record<string, unknown>;
    };
    expect(Object.keys(model.variants ?? {})).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  test('a budget_tokens-only knob (mainline Claude) synthesizes the gateway tiers the routing clamp accepts', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        'anthropic/claude-sonnet-4-5': {
          name: 'Claude Sonnet 4.5',
          reasoning: true,
          reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        },
      },
    });
    const model = (list.all ?? [])[0].models['anthropic/claude-sonnet-4-5'] as {
      variants?: Record<string, unknown>;
    };
    expect(Object.keys(model.variants ?? {})).toEqual(['low', 'medium', 'high']);
  });

  test('a model with no reasoning knob gets NO variants key — never a fabricated ladder', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        'openai/gpt-4.1': { name: 'GPT-4.1', reasoning: false },
        'zai/glm-5': { name: 'GLM-5', reasoning: true, reasoning_options: [] },
      },
    });
    const models = (list.all ?? [])[0].models as Record<string, { variants?: unknown }>;
    expect(models['openai/gpt-4.1'].variants).toBeUndefined();
    expect(models['zai/glm-5'].variants).toBeUndefined();
  });

  test('a variants map the API already sends is kept verbatim (runtime truth wins over derivation)', () => {
    const list = projectLlmCatalogToProviderList({
      models: {
        'openai/gpt-5.6-sol': {
          name: 'GPT-5.6 Sol',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          variants: { deep: { reasoningEffort: 'high' } },
        },
      },
    });
    const model = (list.all ?? [])[0].models['openai/gpt-5.6-sol'] as {
      variants?: Record<string, unknown>;
    };
    expect(model.variants).toEqual({ deep: { reasoningEffort: 'high' } });
  });
});
