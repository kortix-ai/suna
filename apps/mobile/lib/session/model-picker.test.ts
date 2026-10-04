import { pickerProviderList } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

// The source of truth for labels and group order. Mobile cannot depend on the
// package (Metro resolves only @kortix/sdk and @kortix/shared), so the copy in
// model-picker.ts is pinned against it here.
import {
  DEFAULT_MANAGED_MODEL_IDS,
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
} from '../../../../packages/llm-catalog/src/index';

import type { ProjectLlmCatalogProvidersResponse, ProjectLlmCatalogResponse } from '@kortix/sdk';

import {
  PICKER_PROVIDER_LABELS,
  PICKER_PROVIDER_ORDER,
  composerModelList,
  firstPromptPicks,
  modelOptionKey,
  modelPickerOptions,
  offeredModelCount,
  pickerGroupId,
  pickerModelName,
  type PickerModel,
} from './model-picker';

// The live `/model-picker` response of a local project, 2026-09-21.
const catalog = {
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', provider: 'kortix' },
  'kimi-k3': { name: 'Kimi K3 2.8T', provider: 'kortix' },
  'codex/gpt-5.5': { name: 'GPT-5.5 (ChatGPT)', provider: 'codex' },
  'codex/gpt-6-astra': { name: 'GPT-6 Astra (ChatGPT)', provider: 'codex' },
  'anthropic/claude-sonnet-5': { name: 'Claude Sonnet 5', provider: 'anthropic' },
  'anthropic/claude-haiku-3': { name: 'Claude Haiku 3', provider: 'anthropic', enabled: false },
  auto: { name: 'Auto', provider: 'kortix' },
};
const gateway = { gatewayEnabled: true, modelPicker: { models: catalog } as unknown as ProjectLlmCatalogResponse };

// `/llm-catalog/providers` of a gateway-off project (synthetic rows): one
// keyed provider, one with no key.
const nativeCatalog = {
  source: 'models.dev',
  fetched_at: '2026-09-20T00:00:00Z',
  provider_count: 2,
  model_count: 4,
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      env: ['ANTHROPIC_API_KEY'],
      models: [
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', family: 'claude-sonnet', released: '2026-08-01', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', family: 'claude-sonnet', released: '2026-02-01' },
        { id: 'claude-haiku-5', name: 'Claude Haiku 5', family: 'claude-haiku', released: '2026-07-01' },
      ],
    },
    { id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'], models: [{ id: 'llama-5', name: 'Llama 5', family: 'llama', released: '2026-08-01' }] },
  ],
} as unknown as ProjectLlmCatalogProvidersResponse;
const native = { gatewayEnabled: false, llmCatalogProviders: nativeCatalog, secretNames: new Set(['ANTHROPIC_API_KEY']) };

const model = (providerID: string, modelID: string, modelName: string, provider?: string): PickerModel => ({
  providerID,
  providerName: providerID === 'kortix' ? 'Kortix' : providerID,
  modelID,
  modelName,
  provider,
});

describe('copied catalog tables match @kortix/llm-catalog', () => {
  test('group order', () => {
    expect(PICKER_PROVIDER_ORDER).toEqual([...MODEL_SELECTOR_PROVIDER_IDS]);
  });

  test('every copied label equals the package label', () => {
    for (const [id, label] of Object.entries(PICKER_PROVIDER_LABELS)) {
      expect(PROVIDER_LABELS[id]).toBe(label);
    }
  });

  test('managed model ids carry no "/": splitting them cannot invent a provider', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS.some((id) => id.includes('/'))).toBe(false);
  });
});

describe('pickerGroupId — web model-grouping.ts', () => {
  test('a native provider groups under itself', () => {
    expect(pickerGroupId(model('anthropic', 'claude-sonnet-5', 'Sonnet'))).toBe('anthropic');
  });

  test('a gateway model groups under the served upstream provider', () => {
    expect(pickerGroupId(model('kortix', 'codex/gpt-5.5', 'GPT-5.5', 'codex'))).toBe('codex');
  });

  test('without the provider field: the wire id prefix, else kortix', () => {
    expect(pickerGroupId(model('kortix', 'anthropic/claude-sonnet-5', 'Sonnet'))).toBe('anthropic');
    expect(pickerGroupId(model('kortix', 'kimi-k3', 'Kimi'))).toBe('kortix');
  });
});

describe('pickerModelName', () => {
  test('subscription models drop the "(ChatGPT)" suffix; others keep their name', () => {
    expect(pickerModelName(model('kortix', 'codex/gpt-5.5', 'GPT-5.5 (ChatGPT)', 'codex'))).toBe('GPT-5.5');
    expect(pickerModelName(model('kortix', 'kimi-k3', 'Kimi (ChatGPT)', 'kortix'))).toBe('Kimi (ChatGPT)');
  });
});

describe('composerModelList — the SDK list, fed the sources web reads', () => {
  test('gateway on: the /model-picker catalog as kortix models, auto dropped, enablement kept', () => {
    const models = composerModelList(gateway);
    expect(models.every((m) => m.providerID === 'kortix')).toBe(true);
    expect(models.map((m) => m.modelID)).not.toContain('auto');
    expect(models.find((m) => m.modelID === 'anthropic/claude-haiku-3')?.enabled).toBe(false);
    expect(offeredModelCount(models)).toBe(5);
    expect(composerModelList({ gatewayEnabled: true })).toEqual([]);
  });

  test('gateway off, before any sandbox: the catalog providers the project secrets connect (was: no models on mobile home)', () => {
    const models = composerModelList(native);
    expect(models.map((m) => modelOptionKey(m))).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-5',
      'anthropic/claude-sonnet-4-6',
    ]);
    // Thinking levels come from the SDK (`reasoning_options` → `variants`).
    expect(Object.keys(models[0].variants ?? {})).toEqual(['low', 'high']);
  });

  test('gateway off, sandbox up: its /provider list joins; its kortix provider never does', () => {
    const runtimeProviders = {
      all: [
        { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } } },
        { id: 'kortix', name: 'Kortix', models: { 'kimi-k3': { id: 'kimi-k3', name: 'Kimi' } } },
      ],
      connected: ['anthropic', 'kortix'],
      default: {},
    } as never;
    const keys = composerModelList({ ...native, runtimeProviders }).map((m) => modelOptionKey(m));
    expect(keys).toContain('anthropic/claude-sonnet-5');
    expect(keys.some((k) => k.startsWith('kortix/'))).toBe(false);
  });

  test('gateway off: the SDK list already merged with the catalog gives the same models (useRuntimeProviders in a project scope)', () => {
    const runtimeProviders = {
      all: [
        { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } } },
        { id: 'kortix', name: 'Kortix', models: { 'kimi-k3': { id: 'kimi-k3', name: 'Kimi' } } },
      ],
      connected: ['anthropic', 'kortix'],
      default: {},
    } as never;
    // `useComposerModels` feeds `useRuntimeProviders().data` as `runtimeProviders`.
    // Inside `KortixProjectProvider` that is this merged list, not the raw one.
    const merged = pickerProviderList({ ...native, runtimeProviders });
    const once = composerModelList({ ...native, runtimeProviders }).map((m) => modelOptionKey(m));
    const twice = composerModelList({ ...native, runtimeProviders: merged }).map((m) => modelOptionKey(m));
    expect(twice).toEqual(once);
  });
});

describe('modelPickerOptions — groups and rows in web order', () => {
  test('Kortix first, known providers in table order, unknown last by label; rows by name', () => {
    const options = modelPickerOptions(composerModelList(gateway), null);
    expect(options.map((o) => [o.group, o.label])).toEqual([
      ['Kortix', 'DeepSeek V4.1 Flash'],
      ['Kortix', 'Kimi K3 2.8T'],
      ['Anthropic', 'Claude Sonnet 5'],
      ['ChatGPT subscription', 'GPT-5.5'],
      ['ChatGPT subscription', 'GPT-6 Astra'],
    ]);
  });

  test('search text keeps the full name and the wire id', () => {
    const [option] = modelPickerOptions([model('kortix', 'codex/gpt-5.5', 'GPT-5.5 (ChatGPT)', 'codex')], null);
    expect(option.keywords).toContain('codex/gpt-5.5');
    expect(option.keywords).toContain('(ChatGPT)');
  });

  test('an unknown provider keeps its own name as the title', () => {
    const [option] = modelPickerOptions([{ ...model('acme', 'x1', 'X1'), providerName: 'Acme AI' }], null);
    expect(option.group).toBe('Acme AI');
  });

  test('gateway: every offered model is in the empty-search view', () => {
    expect(modelPickerOptions(composerModelList(gateway), null).some((o) => o.searchOnly)).toBe(false);
  });

  test('native: newest per family by default (SDK createModelVisibility); older ones search-only; the selected one always shows', () => {
    const models = composerModelList(native);
    const view = (selected: PickerModel | null) =>
      Object.fromEntries(modelPickerOptions(models, selected).map((o) => [o.key, !o.searchOnly]));
    expect(view(null)).toEqual({
      'anthropic/claude-haiku-5': true,
      'anthropic/claude-sonnet-5': true,
      'anthropic/claude-sonnet-4-6': false,
    });
    const older = models.find((m) => m.modelID === 'claude-sonnet-4-6')!;
    expect(view(older)['anthropic/claude-sonnet-4-6']).toBe(true);
  });
});

describe('firstPromptPicks — what project home sends with the first message', () => {
  test('a level the active model offers travels with the model', () => {
    const gpt = { providerID: 'kortix', modelID: 'codex/gpt-5.5' };
    expect(firstPromptPicks(gpt, 'high', ['low', 'high'])).toEqual({
      model: { providerID: 'kortix', modelID: 'codex/gpt-5.5' },
      variant: 'high',
    });
  });

  test('no level, a level of another model, or no model: nothing to send', () => {
    const gpt = { providerID: 'kortix', modelID: 'codex/gpt-5.5' };
    expect(firstPromptPicks(gpt, null, ['low', 'high'])).toBeNull();
    expect(firstPromptPicks(gpt, 'max', ['low', 'high'])).toBeNull();
    expect(firstPromptPicks(null, 'high', ['low', 'high'])).toBeNull();
  });
});
