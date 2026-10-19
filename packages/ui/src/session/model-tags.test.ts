import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSubscriptionModel, pickerModelName, shouldShowFreeTag } from './model-tags';

const model = (modelID: string, modelName: string, provider?: string) =>
  ({ modelID, modelName, provider, free: false }) as never;

describe('isSubscriptionModel', () => {
  test('recognises the explicit provider field', () => {
    expect(isSubscriptionModel(model('codex/gpt-6-astra', 'x', 'codex'))).toBe(true);
  });

  test('falls back to the wire id for a stale catalog with no provider field', () => {
    expect(isSubscriptionModel(model('codex/gpt-6-astra', 'x'))).toBe(true);
  });

  test('a managed model of the same family is not a subscription model', () => {
    expect(isSubscriptionModel(model('gpt-6-astra', 'x', 'kortix'))).toBe(false);
  });

  test('a BYOK OpenAI model is not a subscription model', () => {
    expect(isSubscriptionModel(model('openai/gpt-5.5', 'x', 'openai'))).toBe(false);
  });
});

describe('pickerModelName', () => {
  test('drops the suffix the group heading already says', () => {
    expect(pickerModelName(model('codex/gpt-6-astra', 'GPT-6 Astra (ChatGPT)', 'codex'))).toBe(
      'GPT-6 Astra',
    );
  });

  test('the managed twin is untouched — both read the same in their own group', () => {
    expect(pickerModelName(model('gpt-6-astra', 'GPT-6 Astra', 'kortix'))).toBe('GPT-6 Astra');
  });

  test('a subscription model without the suffix is left alone', () => {
    expect(pickerModelName(model('codex/gpt-5.5', 'GPT-5.5', 'codex'))).toBe('GPT-5.5');
  });

  test('never returns an empty label, whatever the catalog says', () => {
    expect(pickerModelName(model('codex/x', '(ChatGPT)', 'codex'))).toBe('(ChatGPT)');
  });

  test('a non-subscription model keeps a parenthetical that is part of its name', () => {
    expect(pickerModelName(model('openai/o1', 'o1 (ChatGPT)', 'openai'))).toBe('o1 (ChatGPT)');
  });
});

describe('shouldShowFreeTag is unchanged', () => {
  test('still keys off the free flag', () => {
    expect(shouldShowFreeTag({ free: true, modelID: 'a', modelName: 'b' })).toBe(true);
  });
});

describe('the stripped name is DISPLAY only', () => {
  const selector = readFileSync(
    resolve(import.meta.dir, 'model-selector.tsx'),
    'utf8',
  );

  test('the row renders the stripped name', () => {
    expect(selector).toContain('splitModelLabel(pickerModelName(model))');
  });

  test('search still matches the raw name, so "chatgpt" finds these rows', () => {
    // If this ever becomes pickerModelName(), typing the provider stops
    // finding the models that belong to it.
    expect(selector).toContain("(m.modelName || '').toLowerCase().includes(q)");
  });

  test('the aria label keeps the full name — a screen reader has no group heading', () => {
    expect(selector).toContain("t('defaultAria', { model: model.modelName })");
  });
});
