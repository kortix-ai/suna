import { describe, expect, test } from 'bun:test';
import { MANAGED_FLAGSHIP_MODEL_ID } from '@kortix/llm-catalog/lite';
import type { ProviderListResponse } from '../runtime/runtime-types';

import type { ProjectLlmCatalogResponse, ProjectLlmCatalogProvidersResponse } from '../rest/projects-client';
import type { ModelDefaultsResponse } from '../rest/projects-client/model-defaults';
import { resolveComposerModel, resolveModelDefault } from './composer-model';
import type { FlatModel } from './model-flatten';
import { createModelVisibility, hasUsableModel, modelInDefaultView } from './model-visibility';
import { PLATFORM_DEFAULT_MODEL_ID } from '@kortix/llm-catalog/lite';
import {
  filterToNativeProviders,
  LLM_PROVIDER_CREDENTIALS,
  mergeNativeProviderLists,
  mergeProjectSecretConnectedProviders,
  nativeProviderListFromCatalog,
  normalizeProviderList,
  pickerProviderList,
  projectLlmCatalogToProviderList,
} from './provider-selection';

/**
 * The composer's model list, framework-free. `useRuntimeProviders` (web) and
 * mobile build the picker from these, so the gateway/native source rules, the
 * default-view curation, and the default-model chain exist once.
 */

function flat(providerID: string, modelID: string, extra: Partial<FlatModel> = {}): FlatModel {
  return { providerID, providerName: providerID, modelID, modelName: modelID, ...extra };
}

// ── pickerProviderList ──────────────────────────────────────────────────────

const MODEL_PICKER = {
  models: {
    auto: { name: 'Auto' },
    'glm-5.3-flash': { name: 'GLM 5.3 Flash', enabled: true },
    'anthropic/claude-opus-4-8': { name: 'Claude Opus 4.8', enabled: false },
  },
} as unknown as ProjectLlmCatalogResponse;

const LLM_CATALOG_PROVIDERS = {
  source: 'test',
  fetched_at: '2026-09-01T00:00:00Z',
  provider_count: 2,
  model_count: 3,
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', released: '2026-08-01' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', released: '2026-05-01' },
      ],
    },
    { id: 'mistral', name: 'Mistral', models: [{ id: 'mistral-large', name: 'Mistral Large' }] },
  ],
} as unknown as ProjectLlmCatalogProvidersResponse;

const RUNTIME_PROVIDERS = {
  all: [
    { id: 'kortix', name: 'Kortix', models: { 'glm-5.3-flash': { id: 'glm-5.3-flash' } } },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: { 'claude-opus-4-8': { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 (runtime)' } },
    },
    { id: 'opencode', name: 'OpenCode Zen', models: { 'big-pickle': { id: 'big-pickle' } } },
  ],
  connected: ['kortix', 'opencode'],
  default: { opencode: 'big-pickle' },
} as unknown as ProviderListResponse;

const SECRETS = new Set(['ANTHROPIC_API_KEY']);

describe('pickerProviderList', () => {
  test('gateway: the /model-picker catalog is the list (auto dropped, enablement kept)', () => {
    const list = pickerProviderList({ gatewayEnabled: true, modelPicker: MODEL_PICKER });
    expect(list).toEqual(projectLlmCatalogToProviderList(MODEL_PICKER));
    expect(list?.connected).toEqual(['kortix']);
    expect(Object.keys(list?.all?.[0]?.models ?? {})).toEqual([
      'glm-5.3-flash',
      'anthropic/claude-opus-4-8',
    ]);
  });

  test('gateway without the picker response is not loaded yet', () => {
    expect(pickerProviderList({ gatewayEnabled: true })).toBeUndefined();
  });

  test('native, pre-boot: the catalog synthesis gated on project secrets', () => {
    const list = pickerProviderList({
      gatewayEnabled: false,
      llmCatalogProviders: LLM_CATALOG_PROVIDERS,
      secretNames: SECRETS,
    });
    expect(list).toEqual(nativeProviderListFromCatalog(LLM_CATALOG_PROVIDERS, SECRETS));
    expect(list?.connected).toEqual(['anthropic']);
  });

  test('native, booted: runtime merged over the catalog; kortix never leaks in', () => {
    const list = pickerProviderList({
      gatewayEnabled: false,
      runtimeProviders: RUNTIME_PROVIDERS,
      llmCatalogProviders: LLM_CATALOG_PROVIDERS,
      secretNames: SECRETS,
    });
    const runtime = filterToNativeProviders(
      mergeProjectSecretConnectedProviders(
        normalizeProviderList(RUNTIME_PROVIDERS),
        SECRETS,
        LLM_PROVIDER_CREDENTIALS,
      ),
    );
    expect(list).toEqual(
      mergeNativeProviderLists(nativeProviderListFromCatalog(LLM_CATALOG_PROVIDERS, SECRETS), runtime),
    );
    expect(list?.all?.map((p) => p.id)).toEqual(['anthropic', 'opencode']);
    expect(list?.connected).not.toContain('kortix');
    // The runtime object wins for a shared provider.
    expect(list?.all?.[0]?.models['claude-opus-4-8']?.name).toBe('Claude Opus 4.8 (runtime)');
  });

  test('native: a model-less runtime answer (sandbox still wiring) is ignored', () => {
    const empty = { all: [], connected: [], default: {} } as unknown as ProviderListResponse;
    expect(
      pickerProviderList({
        gatewayEnabled: false,
        runtimeProviders: empty,
        llmCatalogProviders: LLM_CATALOG_PROVIDERS,
        secretNames: SECRETS,
      }),
    ).toEqual(nativeProviderListFromCatalog(LLM_CATALOG_PROVIDERS, SECRETS));
  });
});

// ── createModelVisibility ───────────────────────────────────────────────────

describe('createModelVisibility', () => {
  const recent = '2026-09-01';
  const old = '2024-01-01';
  const catalog = [
    flat('openrouter', 'acme/fast-2', { family: 'fast', releaseDate: recent }),
    flat('openrouter', 'acme/fast-1', { family: 'fast', releaseDate: old }),
    flat('openrouter', 'acme/undated'),
    flat('openrouter', MANAGED_FLAGSHIP_MODEL_ID),
  ];

  test('native: newest per family shows, older versions hide, undated shows only the flagship', () => {
    const isVisible = createModelVisibility({ catalogModels: catalog });
    expect(isVisible({ providerID: 'openrouter', modelID: 'acme/fast-2' })).toBe(true);
    expect(isVisible({ providerID: 'openrouter', modelID: 'acme/fast-1' })).toBe(false);
    expect(isVisible({ providerID: 'openrouter', modelID: 'acme/undated' })).toBe(false);
    expect(isVisible({ providerID: 'openrouter', modelID: MANAGED_FLAGSHIP_MODEL_ID })).toBe(true);
  });

  test('user pins override the default: show reveals, hide hides', () => {
    const isVisible = createModelVisibility({
      catalogModels: catalog,
      pins: [
        { providerID: 'openrouter', modelID: 'acme/fast-1', visibility: 'show' },
        { providerID: 'openrouter', modelID: 'acme/fast-2', visibility: 'hide' },
      ],
    });
    expect(isVisible({ providerID: 'openrouter', modelID: 'acme/fast-1' })).toBe(true);
    expect(isVisible({ providerID: 'openrouter', modelID: 'acme/fast-2' })).toBe(false);
  });

  test('gateway: managed models hide on free tier; BYOK models need their provider connected', () => {
    const gateway = [
      flat('kortix', 'glm-5.3-flash'),
      flat('kortix', 'anthropic/claude-opus-4-8', { provider: 'anthropic', releaseDate: recent }),
    ];
    const paid = createModelVisibility({
      catalogModels: gateway,
      connectedProviderIds: new Set(['anthropic']),
    });
    expect(paid({ providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBe(true);
    expect(paid({ providerID: 'kortix', modelID: 'anthropic/claude-opus-4-8', provider: 'anthropic' })).toBe(
      true,
    );
    const free = createModelVisibility({ catalogModels: gateway, freeTier: true });
    expect(free({ providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBe(false);
    expect(free({ providerID: 'kortix', modelID: 'anthropic/claude-opus-4-8', provider: 'anthropic' })).toBe(
      false,
    );
  });

  test('gateway: the platform default shows on free tier too (KRTX-1067)', () => {
    const gateway = [flat('kortix', PLATFORM_DEFAULT_MODEL_ID), flat('kortix', 'glm-5.3-flash')];
    const free = createModelVisibility({ catalogModels: gateway, freeTier: true });
    expect(free({ providerID: 'kortix', modelID: PLATFORM_DEFAULT_MODEL_ID })).toBe(true);
    expect(free({ providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBe(false);
  });

  test('hasUsableModel: the platform default alone counts as usable on free tier (KRTX-1067)', () => {
    expect(
      hasUsableModel([flat('kortix', PLATFORM_DEFAULT_MODEL_ID)], { freeTier: true }),
    ).toBe(true);
    expect(hasUsableModel([flat('kortix', 'glm-5.3-flash')], { freeTier: true })).toBe(false);
  });
});

describe('modelInDefaultView', () => {
  const hidden = () => false;
  const model = flat('openrouter', 'acme/fast-1');

  test('a search reveals everything; gateway models always show; the selection always shows', () => {
    expect(modelInDefaultView(model, { search: '', isStoreVisible: hidden, selected: null })).toBe(false);
    expect(modelInDefaultView(model, { search: 'acme', isStoreVisible: hidden, selected: null })).toBe(true);
    expect(
      modelInDefaultView(flat('kortix', 'glm-5.3-flash'), {
        search: '',
        isStoreVisible: hidden,
        selected: null,
      }),
    ).toBe(true);
    expect(
      modelInDefaultView(model, {
        search: '',
        isStoreVisible: hidden,
        selected: { providerID: 'openrouter', modelID: 'acme/fast-1' },
      }),
    ).toBe(true);
  });
});

// ── resolveModelDefault / resolveComposerModel ──────────────────────────────

describe('resolveModelDefault', () => {
  const data = {
    agentDefaults: { support: 'anthropic/claude-opus-4-8' },
    projectDefault: 'glm-5.3-flash',
    accountDefault: null,
    platformDefault: 'kimi-k3',
    freeTier: false,
  } as unknown as ModelDefaultsResponse;

  test('agent > project > account > platform, as gateway ModelKeys', () => {
    expect(resolveModelDefault(data, 'support')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-opus-4-8',
    });
    expect(resolveModelDefault(data, 'kortix')).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
    expect(resolveModelDefault({ ...data, projectDefault: null } as ModelDefaultsResponse, undefined)).toEqual({
      providerID: 'kortix',
      modelID: 'kimi-k3',
    });
  });

  test('a free-tier account resolves the platform default (KRTX-1067)', () => {
    // The gateway serves the platform default to every tier (KRTX-1067), so
    // the client resolves it instead of leaving a fresh free account with no
    // model and a disabled Send.
    expect(
      resolveModelDefault(
        { ...data, projectDefault: null, freeTier: true } as ModelDefaultsResponse,
        undefined,
      ),
    ).toEqual({ providerID: 'kortix', modelID: 'kimi-k3' });
  });
});

describe('resolveComposerModel', () => {
  const models = [
    flat('anthropic', 'claude-opus-4-8'),
    flat('anthropic', 'claude-sonnet-4-6'),
    flat('anthropic', 'claude-off', { enabled: false }),
    flat('openai', 'gpt-5.5'),
  ];
  const providers = {
    all: [
      { id: 'anthropic', models: { 'claude-opus-4-8': {}, 'claude-sonnet-4-6': {} } },
      { id: 'openai', models: { 'gpt-5.5': {} } },
    ],
    connected: ['openai', 'anthropic'],
    default: { anthropic: 'claude-sonnet-4-6' },
  } as unknown as ProviderListResponse;
  const key = (providerID: string, modelID: string) => ({ providerID, modelID });

  test('the first VALID explicit pick wins; a disabled or unknown pick is skipped', () => {
    const resolved = resolveComposerModel({
      models,
      picks: [key('anthropic', 'claude-off'), undefined, key('openai', 'gpt-5.5')],
      serverDefault: key('anthropic', 'claude-opus-4-8'),
    });
    expect(resolved.explicit).toEqual(key('openai', 'gpt-5.5'));
    expect(resolved.model).toEqual(key('openai', 'gpt-5.5'));
  });

  test('no pick: server default > global default > agent.model > fallback', () => {
    const base = { models, providers };
    expect(
      resolveComposerModel({
        ...base,
        serverDefault: key('anthropic', 'claude-opus-4-8'),
        globalDefault: key('openai', 'gpt-5.5'),
      }),
    ).toEqual({
      explicit: undefined,
      model: key('anthropic', 'claude-opus-4-8'),
      fallback: key('anthropic', 'claude-sonnet-4-6'),
    });
    expect(resolveComposerModel({ ...base, globalDefault: key('openai', 'gpt-5.5') }).model).toEqual(
      key('openai', 'gpt-5.5'),
    );
    expect(resolveComposerModel({ ...base, agentModel: key('anthropic', 'claude-opus-4-8') }).model).toEqual(
      key('anthropic', 'claude-opus-4-8'),
    );
  });

  test('fallback: config model > recent > provider default > first model of a connected provider', () => {
    expect(
      resolveComposerModel({ models, providers, configModel: 'anthropic/claude-opus-4-8' }).fallback,
    ).toEqual(key('anthropic', 'claude-opus-4-8'));
    expect(
      resolveComposerModel({ models, providers, recent: [key('x', 'y'), key('anthropic', 'claude-opus-4-8')] })
        .fallback,
    ).toEqual(key('anthropic', 'claude-opus-4-8'));
    // Provider order (`all`) decides; anthropic's configured default wins.
    expect(resolveComposerModel({ models, providers }).fallback).toEqual(
      key('anthropic', 'claude-sonnet-4-6'),
    );
    // No configured default: the provider's first seedable model.
    expect(
      resolveComposerModel({ models, providers: { ...providers, default: {} } }).fallback,
    ).toEqual(key('anthropic', 'claude-opus-4-8'));
    expect(resolveComposerModel({ models: [] }).model).toBeUndefined();
  });

  test('a bare Bedrock id heals to its inference-profile twin', () => {
    const bedrock = [
      flat('amazon-bedrock', 'anthropic.claude-opus-5'),
      flat('amazon-bedrock', 'global.anthropic.claude-opus-5'),
    ];
    const resolved = resolveComposerModel({
      models: bedrock,
      picks: [key('amazon-bedrock', 'anthropic.claude-opus-5')],
    });
    expect(resolved.explicit).toEqual(key('amazon-bedrock', 'anthropic.claude-opus-5'));
    expect(resolved.model).toEqual(key('amazon-bedrock', 'global.anthropic.claude-opus-5'));
  });
});
