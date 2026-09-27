import { describe, expect, test } from 'bun:test';

// The source of truth for labels and group order. Mobile cannot depend on the
// package (Metro resolves only @kortix/sdk and @kortix/shared), so the copy in
// model-picker.ts is pinned against it here.
import {
  DEFAULT_MANAGED_MODEL_IDS,
  generationControlCapabilities,
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
} from '../../../../packages/llm-catalog/src/index';

import {
  PICKER_PROVIDER_LABELS,
  PICKER_PROVIDER_ORDER,
  catalogPickerModels,
  catalogThinkingLevels,
  firstPromptPicks,
  modelPickerOptions,
  offeredSessionModels,
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
};

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

describe('catalogPickerModels — project home', () => {
  test('offered models only, as kortix gateway models with their upstream provider', () => {
    const models = catalogPickerModels(catalog);
    expect(models.map((m) => m.modelID)).not.toContain('anthropic/claude-haiku-3');
    expect(models.find((m) => m.modelID === 'codex/gpt-5.5')).toEqual({
      providerID: 'kortix',
      providerName: 'Kortix',
      modelID: 'codex/gpt-5.5',
      modelName: 'GPT-5.5 (ChatGPT)',
      provider: 'codex',
    });
    expect(catalogPickerModels(undefined)).toEqual([]);
  });

  test('skips the auto alias', () => {
    expect(catalogPickerModels({ auto: { name: 'Auto' }, 'kortix/auto': { name: 'Auto' } })).toEqual([]);
  });
});

describe('modelPickerOptions — groups and rows in web order', () => {
  test('Kortix first, known providers in table order, unknown last by label; rows by name', () => {
    const options = modelPickerOptions(catalogPickerModels(catalog), (m) => m.modelID);
    expect(options.map((o) => [o.group, o.label])).toEqual([
      ['Kortix', 'DeepSeek V4.1 Flash'],
      ['Kortix', 'Kimi K3 2.8T'],
      ['Anthropic', 'Claude Sonnet 5'],
      ['ChatGPT subscription', 'GPT-5.5'],
      ['ChatGPT subscription', 'GPT-6 Astra'],
    ]);
  });

  test('search text keeps the full name and the wire id', () => {
    const [option] = modelPickerOptions([model('kortix', 'codex/gpt-5.5', 'GPT-5.5 (ChatGPT)', 'codex')], (m) => m.modelID);
    expect(option.keywords).toContain('codex/gpt-5.5');
    expect(option.keywords).toContain('(ChatGPT)');
  });

  test('an unknown provider keeps its own name as the title', () => {
    const [option] = modelPickerOptions([{ ...model('acme', 'x1', 'X1'), providerName: 'Acme AI' }], (m) => m.modelID);
    expect(option.group).toBe('Acme AI');
  });
});

describe('offeredSessionModels — the thread', () => {
  const sandbox = [
    model('kortix', 'kimi-k3', 'Kimi K3 2.8T'),
    model('kortix', 'codex/gpt-5.5', 'GPT-5.5 (ChatGPT)'),
    model('kortix', 'anthropic/claude-haiku-3', 'Claude Haiku 3'),
    model('kortix', 'auto', 'Auto'),
    model('kortix', 'not-in-catalog', 'Ghost'),
    model('openai', 'gpt-5', 'GPT-5'),
  ];

  test('gateway project: the catalog is the list, the same one project home shows', () => {
    const offered = offeredSessionModels(sandbox, catalog);
    expect(offered.map((m) => m.modelID)).toEqual([
      'deepseek-v4.1-flash',
      'kimi-k3',
      'codex/gpt-5.5',
      'codex/gpt-6-astra',
      'anthropic/claude-sonnet-5',
    ]);
    expect(offered.every((m) => m.providerID === 'kortix')).toBe(true);
    expect(offered[2].provider).toBe('codex');
  });

  test('gateway project: the sandbox model wins when it exists (it carries the variants)', () => {
    const withVariants = [{ ...sandbox[0], variants: { high: {} } }];
    const kimi = offeredSessionModels(withVariants, catalog).find((m) => m.modelID === 'kimi-k3');
    expect(Object.keys(kimi?.variants ?? {})).toEqual(['high']);
  });

  test('native project (no catalog): every provider but kortix, no auto alias', () => {
    expect(offeredSessionModels(sandbox, undefined).map((m) => m.modelID)).toEqual(['gpt-5']);
  });
});

describe('catalogThinkingLevels — web projectLlmCatalogToProviderList', () => {
  // `reasoning_options` of the live catalog, 2026-09-21. It sends `variants: {}` for every model.
  const live = [
    { name: 'GPT-5.5', variants: {}, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }] },
    { name: 'Kimi K3', variants: {}, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }] },
    { name: 'Claude', reasoning_options: [{ type: 'budget_tokens', min: 1024 }] },
    { name: 'DeepSeek', variants: {}, reasoning: true },
    { name: 'Toggle only', reasoning_options: [{ type: 'toggle' }] },
  ];

  test('the published effort values; budget_tokens → low/medium/high; nothing else', () => {
    expect(live.map(catalogThinkingLevels)).toEqual([
      ['none', 'low', 'medium', 'high', 'xhigh'],
      ['low', 'high', 'max'],
      ['low', 'medium', 'high'],
      [],
      [],
    ]);
  });

  test('equals the catalog package rule the gateway clamps requests with', () => {
    for (const entry of live) {
      const expected = generationControlCapabilities({ id: 'x', ...entry } as never).reasoningEffort?.values ?? [];
      expect(catalogThinkingLevels(entry)).toEqual([...expected]);
    }
  });

  test('an explicit variants map from the API wins', () => {
    expect(catalogThinkingLevels({ variants: { fast: {}, deep: {} }, reasoning_options: [{ type: 'effort', values: ['low'] }] })).toEqual(['fast', 'deep']);
  });

  test('home and thread get the same levels: catalog models carry them as variants', () => {
    const [gpt] = catalogPickerModels({ 'codex/gpt-5.5': live[0] });
    expect(Object.keys(gpt.variants ?? {})).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    // The sandbox lists the model with no levels of its own: the catalog's fill in.
    const [threadGpt] = offeredSessionModels<PickerModel>(
      [{ providerID: 'kortix', providerName: 'Kortix', modelID: 'codex/gpt-5.5', modelName: 'GPT-5.5' }],
      { 'codex/gpt-5.5': live[0] },
    );
    expect(Object.keys(threadGpt.variants ?? {})).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
  });
});

describe('firstPromptPicks — what project home sends with the first message', () => {
  test('a level the active model offers travels with the model', () => {
    expect(firstPromptPicks('codex/gpt-5.5', 'high', ['low', 'high'])).toEqual({
      model: { providerID: 'kortix', modelID: 'codex/gpt-5.5' },
      variant: 'high',
    });
  });

  test('no level, a level of another model, or no model: nothing to send', () => {
    expect(firstPromptPicks('codex/gpt-5.5', null, ['low', 'high'])).toBeNull();
    expect(firstPromptPicks('codex/gpt-5.5', 'max', ['low', 'high'])).toBeNull();
    expect(firstPromptPicks(null, 'high', ['low', 'high'])).toBeNull();
  });
});
