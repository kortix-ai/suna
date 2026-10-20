import { describe, expect, test } from 'bun:test';
import { MANAGED_FLAGSHIP_MODEL_ID } from '@kortix/llm-catalog/lite';
import type { ProviderListResponse } from '../runtime/runtime-types';

import type {
  ProjectLlmCatalogProvidersResponse,
  ProjectLlmCatalogResponse,
} from '../rest/projects-client';
import type { ModelDefaultsResponse } from '../rest/projects-client/model-defaults';
import {
  latestPromptModel,
  resolveComposerModel,
  resolveModelDefault,
  sessionModelCandidates,
} from './composer-model';
import type { FlatModel } from './model-flatten';
import { createModelVisibility, hasUsableModel, modelInDefaultView } from './model-visibility';
import { PLATFORM_DEFAULT_MODEL_ID } from '@kortix/llm-catalog/lite';
import { pickerProviderList, projectLlmCatalogToProviderList } from './provider-selection';

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
    const list = pickerProviderList({ modelPicker: MODEL_PICKER });
    expect(list).toEqual(projectLlmCatalogToProviderList(MODEL_PICKER));
    expect(list?.connected).toEqual(['kortix']);
    expect(Object.keys(list?.all?.[0]?.models ?? {})).toEqual([
      'glm-5.3-flash',
      'anthropic/claude-opus-4-8',
    ]);
  });

  test('gateway without the picker response is not loaded yet', () => {
    expect(pickerProviderList({})).toBeUndefined();
  });

  test('the gateway is the only source: deprecated native inputs change nothing', () => {
    const list = pickerProviderList({
      gatewayEnabled: false,
      modelPicker: MODEL_PICKER,
      runtimeProviders: RUNTIME_PROVIDERS,
      llmCatalogProviders: LLM_CATALOG_PROVIDERS,
      secretNames: SECRETS,
    });
    expect(list).toEqual(projectLlmCatalogToProviderList(MODEL_PICKER));
    expect(pickerProviderList({ modelPicker: MODEL_PICKER })).toEqual(list);
    expect(
      pickerProviderList({ runtimeProviders: RUNTIME_PROVIDERS, llmCatalogProviders: LLM_CATALOG_PROVIDERS }),
    ).toBeUndefined();
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
    expect(
      paid({ providerID: 'kortix', modelID: 'anthropic/claude-opus-4-8', provider: 'anthropic' }),
    ).toBe(true);
    const free = createModelVisibility({ catalogModels: gateway, freeTier: true });
    expect(free({ providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBe(false);
    expect(
      free({ providerID: 'kortix', modelID: 'anthropic/claude-opus-4-8', provider: 'anthropic' }),
    ).toBe(false);
  });

  test('gateway: free tier sees no managed model, the platform default included', () => {
    const gateway = [flat('kortix', PLATFORM_DEFAULT_MODEL_ID), flat('kortix', 'glm-5.3-flash')];
    const free = createModelVisibility({ catalogModels: gateway, freeTier: true });
    expect(free({ providerID: 'kortix', modelID: PLATFORM_DEFAULT_MODEL_ID })).toBe(false);
    expect(free({ providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBe(false);
  });

  test('hasUsableModel: no managed model counts as usable on free tier', () => {
    expect(
      hasUsableModel([flat('kortix', PLATFORM_DEFAULT_MODEL_ID)], { freeTier: true }),
    ).toBe(false);
    expect(hasUsableModel([flat('kortix', 'glm-5.3-flash')], { freeTier: true })).toBe(false);
  });
});

describe('modelInDefaultView', () => {
  const hidden = () => false;
  const model = flat('openrouter', 'acme/fast-1');

  test('a search reveals everything; gateway models always show; the selection always shows', () => {
    expect(modelInDefaultView(model, { search: '', isStoreVisible: hidden, selected: null })).toBe(
      false,
    );
    expect(
      modelInDefaultView(model, { search: 'acme', isStoreVisible: hidden, selected: null }),
    ).toBe(true);
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
    expect(resolveModelDefault(data, 'kortix')).toEqual({
      providerID: 'kortix',
      modelID: 'glm-5.3-flash',
    });
    expect(
      resolveModelDefault({ ...data, projectDefault: null } as ModelDefaultsResponse, undefined),
    ).toEqual({
      providerID: 'kortix',
      modelID: 'kimi-k3',
    });
  });

  test('a free-tier account never resolves the platform default', () => {
    // The gateway refuses every managed model to free tier.
    expect(
      resolveModelDefault(
        { ...data, projectDefault: null, freeTier: true } as ModelDefaultsResponse,
        undefined,
      ),
    ).toBeUndefined();
  });

  test('a null platform default resolves to nothing, not a crash', () => {
    // The API answers `platformDefault: null` when the gateway has no platform
    // fallback configured; the wire type says `string | null` to match it.
    expect(
      resolveModelDefault(
        { ...data, projectDefault: null, platformDefault: null } as ModelDefaultsResponse,
        undefined,
      ),
    ).toBeUndefined();
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
    expect(
      resolveComposerModel({ ...base, globalDefault: key('openai', 'gpt-5.5') }).model,
    ).toEqual(key('openai', 'gpt-5.5'));
    expect(
      resolveComposerModel({ ...base, agentModel: key('anthropic', 'claude-opus-4-8') }).model,
    ).toEqual(key('anthropic', 'claude-opus-4-8'));
  });

  test('fallback: config model > recent > provider default > first model of a connected provider', () => {
    expect(
      resolveComposerModel({ models, providers, configModel: 'anthropic/claude-opus-4-8' })
        .fallback,
    ).toEqual(key('anthropic', 'claude-opus-4-8'));
    expect(
      resolveComposerModel({
        models,
        providers,
        recent: [key('x', 'y'), key('anthropic', 'claude-opus-4-8')],
      }).fallback,
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
});

describe('sessionModelCandidates', () => {
  const kortix = (modelID: string) => ({ providerID: 'kortix', modelID });
  const session = (pin?: string, source?: string) => ({
    metadata: {
      ...(pin ? { opencode_model: pin } : {}),
      ...(source ? { opencode_model_source: source } : {}),
    },
  });

  test('a pin someone chose (CLI, SDK, Slack, PUT /model) ranks before the last prompt', () => {
    expect(
      sessionModelCandidates({
        session: session('kortix/model-b', 'explicit'),
        lastPromptModel: kortix('model-c'),
      }),
    ).toEqual([kortix('model-b'), kortix('model-c')]);
  });

  test('a pin the platform re-pointed off a retired model ranks like a chosen one', () => {
    expect(
      sessionModelCandidates({
        session: session('kortix/model-b', 'repointed'),
        lastPromptModel: kortix('model-retired'),
      }),
    ).toEqual([kortix('model-b'), kortix('model-retired')]);
  });

  test('a default pin ranks after the model the session last ran on', () => {
    for (const source of ['account', 'project', 'agent', 'platform', undefined]) {
      expect(
        sessionModelCandidates({
          session: session('kortix/model-b', source),
          lastPromptModel: kortix('model-c'),
          }),
      ).toEqual([kortix('model-c'), kortix('model-b')]);
    }
  });

  test('a session with no pin and no prompt has no model of its own', () => {
    expect(sessionModelCandidates({ session: session() })).toEqual([]);
    expect(sessionModelCandidates({ session: null })).toEqual([]);
    expect(
      sessionModelCandidates({ lastPromptModel: kortix('model-c') }),
    ).toEqual([kortix('model-c')]);
  });

  test('a provider/model pin is a gateway wire id; the deprecated gatewayEnabled changes nothing', () => {
    const expected = [{ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' }];
    expect(
      sessionModelCandidates({ session: session('anthropic/claude-sonnet-4-6', 'explicit'), gatewayEnabled: false }),
    ).toEqual(expected);
    expect(sessionModelCandidates({ session: session('anthropic/claude-sonnet-4-6', 'explicit') })).toEqual(expected);
  });
});

describe('latestPromptModel', () => {
  test('reads the newest user message that records a model', () => {
    expect(
      latestPromptModel([
        { role: 'user', model: { provider: 'kortix', model: 'model-b' } },
        { role: 'user', model: { provider: 'kortix', model: 'model-c' } },
        { role: 'assistant', model: { provider: 'kortix', model: 'model-x' } },
        // A row with no model recorded says nothing about the session's model.
        { role: 'user', model: null },
      ]),
    ).toEqual({ providerID: 'kortix', modelID: 'model-c' });
  });

  test('a transcript with no user model has none', () => {
    expect(latestPromptModel([])).toBeUndefined();
    expect(latestPromptModel(undefined)).toBeUndefined();
    expect(
      latestPromptModel([{ role: 'assistant', model: { provider: 'kortix', model: 'model-x' } }]),
    ).toBeUndefined();
  });
});
