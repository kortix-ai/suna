import { describe, expect, test } from 'bun:test';

// The source of truth for labels and group order. Mobile cannot depend on the
// package (Metro resolves only @kortix/sdk and @kortix/shared), so the copy in
// model-picker.ts is pinned against it here.
import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
} from '../../../../packages/llm-catalog/src/index';

import type { ProjectLlmCatalogResponse } from '@kortix/sdk';

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
const gateway = { models: catalog } as unknown as ProjectLlmCatalogResponse;

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
});

describe('pickerGroupId — web model-grouping.ts', () => {
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

describe('composerModelList — the SDK list from /model-picker', () => {
  test('the /model-picker catalog as kortix models, auto dropped, enablement kept', () => {
    const models = composerModelList(gateway);
    expect(models.every((m) => m.providerID === 'kortix')).toBe(true);
    expect(models.map((m) => m.modelID)).not.toContain('auto');
    expect(models.find((m) => m.modelID === 'anthropic/claude-haiku-3')?.enabled).toBe(false);
    expect(offeredModelCount(models)).toBe(5);
    expect(composerModelList(undefined)).toEqual([]);
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

  test('a custom provider keeps its own name as the title', () => {
    const [option] = modelPickerOptions([{ ...model('kortix', 'acme/x1', 'X1', 'acme'), providerName: 'Acme AI' }], null);
    expect(option.group).toBe('Acme AI');
  });

  test('every offered model is in the empty-search view', () => {
    expect(modelPickerOptions(composerModelList(gateway), null).some((o) => o.searchOnly)).toBe(false);
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

// KRTX-3011: `/model-picker` keeps a model a default names even when its
// provider is not connected, marked `available: false`. Mobile has no row
// action to connect it, so it is not a row and does not count as offered.
describe('an unavailable model (KRTX-3011)', () => {
  const unavailable = {
    models: {
      'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', provider: 'kortix' },
      'codex/gpt-6-astra': { name: 'GPT-6 Astra (ChatGPT)', provider: 'codex', available: false, availability: 'login' },
    },
  } as unknown as ProjectLlmCatalogResponse;

  test('is not a picker row and is not counted as offered', () => {
    const models = composerModelList(unavailable);
    expect(modelPickerOptions(models, null).map((o) => o.label)).toEqual(['DeepSeek V4.1 Flash']);
    expect(offeredModelCount(models)).toBe(1);
  });
});
