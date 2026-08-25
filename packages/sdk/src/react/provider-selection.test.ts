import { describe, expect, test } from 'bun:test';

import {
  applyEnablementToProviderList,
  LLM_PROVIDER_CREDENTIALS,
  type ProviderListResponse,
  connectedGatewayProviderIdsFromSecretNames,
  mergeProviderLists,
  mergeProjectSecretConnectedProviders,
  mergeNativeProviderLists,
  nativeProviderListFromCatalog,
  projectLlmCatalogToProviderList,
} from './provider-selection';
import { flattenModels } from './model-flatten';

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
// the `qk.project.modelPicker(id)` query the Manage-models tab writes through. A
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

// Native mode, BEFORE any sandbox runtime exists (project home, cold session):
// there is no opencode /provider list to read, so the picker synthesizes a
// ProviderListResponse from the ungated /llm-catalog/providers route plus the
// project's secret NAMES. Without this the composer showed "No models
// available" on every native project until a box booted — connecting a key
// changed nothing.
describe('nativeProviderListFromCatalog (pre-runtime native picker source)', () => {
  const catalog = {
    source: 'models.dev',
    fetched_at: '2026-08-24T00:00:00Z',
    provider_count: 3,
    model_count: 5,
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        env: ['ANTHROPIC_API_KEY'],
        models: [
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', released: '2026-02-01' },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', released: '2025-10-01' },
        ],
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        env: ['OPENROUTER_API_KEY'],
        models: [{ id: 'z-ai/glm-4.7-flash', name: 'GLM-4.7-Flash', released: null }],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        env: ['OPENAI_API_KEY'],
        models: [{ id: 'gpt-5.2', name: 'GPT-5.2', released: null }],
      },
    ],
  };

  test('providers whose key is in the secrets connect, with catalog models flattened-compatible', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['ANTHROPIC_API_KEY']));
    expect(list.connected).toEqual(['anthropic']);
    const anthropic = (list.all ?? []).find((p) => p.id === 'anthropic') as {
      models: Record<string, { name?: string; release_date?: string }>;
    };
    expect(Object.keys(anthropic.models)).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5']);
    // `released` (catalog wire name) must land as `release_date` (the field
    // flattenModels/the picker sort read).
    expect(anthropic.models['claude-sonnet-4-6']!.release_date).toBe('2026-02-01');
    // Disconnected providers are omitted entirely — 195 catalog providers per
    // paint would be dead weight the flatten filters out anyway.
    expect((list.all ?? []).some((p) => p.id === 'openai')).toBe(false);
  });

  test('the synthesized list flattens to native FlatModels', () => {
    const list = nativeProviderListFromCatalog(
      catalog as never,
      new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']),
    );
    const flat = flattenModels(list, { providerMode: 'native' });
    expect(flat.map((m) => `${m.providerID}/${m.modelID}`).sort()).toEqual([
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-sonnet-4-6',
      'openrouter/z-ai/glm-4.7-flash',
    ]);
  });

  test('no connected key and no Zen entry ⇒ an EMPTY list (the connect-provider call to action stays)', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set());
    expect(list.all).toEqual([]);
    expect(list.connected).toEqual([]);
  });

  // opencode auto-connects the OpenCode Zen provider (`opencode`) with its
  // FREE models even when no key is present — the running sandbox always
  // lists them. The pre-runtime source must too, or the picker's contents
  // change the moment the box boots.
  test('OpenCode Zen free models are always listed (keyless), paid Zen models are not', () => {
    const withZen = {
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          id: 'opencode',
          name: 'OpenCode Zen',
          env: ['OPENCODE_API_KEY'],
          models: [
            { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', released: '2026-07-09', cost: { input: 2.5, output: 15 } },
            { id: 'hy3-free', name: 'Hy3 Free', released: '2026-05-01', cost: { input: 0, output: 0 } },
            { id: 'big-pickle', name: 'Big Pickle', released: '2026-06-01', cost: { input: 0, output: 0 } },
          ],
        },
      ],
    };
    const list = nativeProviderListFromCatalog(withZen as never, new Set());
    expect(list.connected).toEqual(['opencode']);
    const zen = (list.all ?? []).find((p) => p.id === 'opencode') as { models: Record<string, unknown> };
    expect(Object.keys(zen.models)).toEqual(['big-pickle', 'hy3-free']);
    // Zen ranks after every keyed provider, and never becomes the default pick
    // when a keyed provider exists.
    const keyed = nativeProviderListFromCatalog(withZen as never, new Set(['ANTHROPIC_API_KEY']));
    expect((keyed.all ?? []).map((p) => p.id)).toEqual(['anthropic', 'opencode']);
    expect((keyed as { default?: Record<string, string> }).default).toEqual({
      anthropic: 'claude-sonnet-4-6',
      opencode: 'big-pickle',
    });
  });

  test('never synthesizes the synthetic kortix provider', () => {
    const withKortix = {
      ...catalog,
      providers: [
        ...catalog.providers,
        { id: 'kortix', name: 'Kortix', env: [], models: [{ id: 'glm-5.2', name: 'GLM', released: null }] },
      ],
    };
    const list = nativeProviderListFromCatalog(withKortix as never, new Set(['ANTHROPIC_API_KEY']));
    expect((list.all ?? []).some((p) => p.id === 'kortix')).toBe(false);
  });
});

// The first live dev run of the pre-runtime source auto-picked
// `Hy-MT2-30B-A3B` (catalog file order) and OpenRouter answered "No endpoints
// found that support tool use" on the user's very first message. The
// synthesized list must therefore carry a per-provider `default` (the
// composer's fallback reads `providers.default[id]` before "first model") and
// order deterministically toward flagships.
describe('nativeProviderListFromCatalog — default pick quality', () => {
  const catalog = {
    source: 'models.dev',
    fetched_at: '2026-08-24T00:00:00Z',
    provider_count: 2,
    model_count: 5,
    providers: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        env: ['OPENROUTER_API_KEY'],
        models: [
          { id: 'hy/hy-mt2-30b-a3b', name: 'Hy-MT2-30B-A3B', released: '2025-01-01' },
          { id: 'z-ai/glm-4.7-flash', name: 'GLM-4.7-Flash', released: '2026-06-01' },
          { id: 'old/thing', name: 'Old Thing', released: null },
        ],
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        env: ['ANTHROPIC_API_KEY'],
        models: [
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', released: '2025-10-01' },
          { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', released: '2026-01-01' },
        ],
      },
    ],
  };

  test('a known flagship becomes the provider default', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['ANTHROPIC_API_KEY']));
    expect((list as { default?: Record<string, string> }).default).toEqual({
      anthropic: 'claude-opus-4-8',
    });
  });

  test('a provider with no flagship candidate defaults to its most recently released model', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['OPENROUTER_API_KEY']));
    expect((list as { default?: Record<string, string> }).default).toEqual({
      openrouter: 'z-ai/glm-4.7-flash',
    });
  });

  test('flagship-table providers rank before the rest, so anthropic beats openrouter as first pick', () => {
    const list = nativeProviderListFromCatalog(
      catalog as never,
      new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']),
    );
    expect((list.all ?? []).map((p) => p.id)).toEqual(['anthropic', 'openrouter']);
    expect(list.connected).toEqual(['anthropic', 'openrouter']);
  });

  test('models within a provider are ordered newest-first', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['OPENROUTER_API_KEY']));
    const openrouter = (list.all ?? []).find((p) => p.id === 'openrouter') as {
      models: Record<string, unknown>;
    };
    expect(Object.keys(openrouter.models)).toEqual([
      'z-ai/glm-4.7-flash',
      'hy/hy-mt2-30b-a3b',
      'old/thing',
    ]);
  });
});

// UX parity with the runtime picker (field report: the pre-runtime list showed
// duplicate names and every historical version, and no thinking-mode row).
// The catalog wire payload (runtimeModelCatalog snapshot = @kortix/llm-catalog
// Catalog) already carries family/capabilities/reasoning_options — the
// synthesized entries must pass them through so the picker's newest-per-family
// curation, capability badges, and the variant (thinking mode) row behave
// exactly as they do once the runtime list loads.
describe('nativeProviderListFromCatalog — metadata parity with the runtime picker', () => {
  const catalog = {
    source: 'models.dev',
    fetched_at: '2026-08-24T00:00:00Z',
    provider_count: 1,
    model_count: 3,
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        env: ['ANTHROPIC_API_KEY'],
        models: [
          {
            id: 'claude-opus-4-8',
            name: 'Claude Opus 4.8',
            released: '2026-01-01',
            family: 'claude-opus',
            reasoning: true,
            reasoning_options: [
              { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
            ],
            tool_call: true,
            attachment: true,
            limit: { context: 200000, output: 64000 },
            cost: { input: 5, output: 25 },
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            released: '2025-11-01',
            family: 'claude-sonnet',
            reasoning: true,
            reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 32000 }],
            tool_call: true,
          },
          {
            id: 'claude-3-haiku',
            name: 'Claude 3 Haiku',
            released: '2024-03-01',
            family: 'claude-haiku',
            tool_call: true,
          },
        ],
      },
    ],
  };

  test('family, capabilities, limits, and cost survive onto the FlatModel', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['ANTHROPIC_API_KEY']));
    const flat = flattenModels(list, { providerMode: 'native' });
    const opus = flat.find((m) => m.modelID === 'claude-opus-4-8')!;
    expect(opus.family).toBe('claude-opus');
    expect(opus.capabilities).toEqual({ reasoning: true, vision: true, toolcall: true });
    expect(opus.contextWindow).toBe(200000);
    expect(opus.cost).toEqual({ input: 5, output: 25 });
    expect(opus.releaseDate).toBe('2026-01-01');
  });

  test('an effort knob synthesizes the same variant IDS opencode derives, so the thinking-mode row renders pre-runtime', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['ANTHROPIC_API_KEY']));
    const flat = flattenModels(list, { providerMode: 'native' });
    const opus = flat.find((m) => m.modelID === 'claude-opus-4-8')!;
    expect(Object.keys(opus.variants ?? {})).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('a budget_tokens knob synthesizes high/max, mirroring opencode budgetVariants', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['ANTHROPIC_API_KEY']));
    const flat = flattenModels(list, { providerMode: 'native' });
    const sonnet = flat.find((m) => m.modelID === 'claude-sonnet-4-6')!;
    expect(Object.keys(sonnet.variants ?? {})).toEqual(['high', 'max']);
  });

  test('a model with no reasoning knob gets no variants at all', () => {
    const list = nativeProviderListFromCatalog(catalog as never, new Set(['ANTHROPIC_API_KEY']));
    const flat = flattenModels(list, { providerMode: 'native' });
    const haiku = flat.find((m) => m.modelID === 'claude-3-haiku')!;
    expect(haiku.variants ?? {}).toEqual({});
  });
});

// One picker across sandbox states: pre-boot the catalog synthesizes the
// list, post-boot the runtime reports it. Swapping sources changed the
// picker's contents on boot (different provider order, Zen appearing, the
// auto-picked default flipping). The merge keeps ONE list: runtime truth per
// provider, catalog order + curated defaults, runtime-only extras appended.
describe('mergeNativeProviderLists (catalog ∪ runtime, one picker across boot)', () => {
  const catalog = {
    all: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'env',
        models: {
          'claude-opus-4-8': { id: 'claude-opus-4-8', name: 'Opus', variants: { high: {}, max: {} } },
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Sonnet' },
        },
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        source: 'env',
        models: { 'z-ai/glm-4.7-flash': { id: 'z-ai/glm-4.7-flash', name: 'GLM' } },
      },
    ],
    connected: ['anthropic', 'openrouter'],
    default: { anthropic: 'claude-opus-4-8', openrouter: 'z-ai/glm-4.7-flash' },
  } as never;
  const runtime = {
    all: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        source: 'api',
        models: { 'big-pickle': { id: 'big-pickle', name: 'Big Pickle' } },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'env',
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            name: 'Opus',
            variants: { high: { thinking: { budgetTokens: 16000 } }, max: { thinking: { budgetTokens: 31999 } } },
          },
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Sonnet' },
          'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Haiku' },
        },
      },
    ],
    connected: ['opencode', 'anthropic'],
    default: { anthropic: 'claude-haiku-4-5', opencode: 'big-pickle' },
  } as never;

  test('runtime provider objects win for shared ids (real variant settings), catalog order is kept, extras append', () => {
    const merged = mergeNativeProviderLists(catalog, runtime)!;
    expect((merged.all ?? []).map((p) => p.id)).toEqual(['anthropic', 'openrouter', 'opencode']);
    const anthropic = (merged.all ?? []).find((p) => p.id === 'anthropic') as {
      models: Record<string, { variants?: Record<string, unknown> }>;
    };
    expect(Object.keys(anthropic.models)).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
    expect(anthropic.models['claude-opus-4-8']!.variants).toEqual({
      high: { thinking: { budgetTokens: 16000 } },
      max: { thinking: { budgetTokens: 31999 } },
    });
    expect(merged.connected).toEqual(['anthropic', 'openrouter', 'opencode']);
  });

  test('the curated catalog default wins over the runtime default when the runtime serves that model', () => {
    const merged = mergeNativeProviderLists(catalog, runtime)!;
    expect((merged as { default?: Record<string, string> }).default).toEqual({
      anthropic: 'claude-opus-4-8',
      openrouter: 'z-ai/glm-4.7-flash',
      opencode: 'big-pickle',
    });
  });

  test('a catalog default the runtime does not serve falls back to the runtime default', () => {
    const skewed = {
      ...(catalog as { default: Record<string, string> }),
      default: { anthropic: 'claude-opus-5', openrouter: 'z-ai/glm-4.7-flash' },
    } as never;
    const merged = mergeNativeProviderLists(skewed, runtime)!;
    expect((merged as { default?: Record<string, string> }).default?.anthropic).toBe('claude-haiku-4-5');
  });

  test('either side missing returns the other unchanged', () => {
    expect(mergeNativeProviderLists(catalog, undefined)).toBe(catalog);
    expect(mergeNativeProviderLists(undefined, runtime)).toBe(runtime);
    expect(mergeNativeProviderLists(undefined, undefined)).toBeUndefined();
  });
});
