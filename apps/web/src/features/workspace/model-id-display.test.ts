import { describe, expect, test } from 'bun:test';

import { modelIdAddsInformation, slugifyModelName } from './model-id-display';

describe('slugifyModelName', () => {
  test('kebab-cases the way catalog IDs are written', () => {
    expect(slugifyModelName('DeepSeek V4 Flash')).toBe('deepseek-v4-flash');
    expect(slugifyModelName('Claude Sonnet 4.5')).toBe('claude-sonnet-4-5');
    expect(slugifyModelName('  GPT-5  ')).toBe('gpt-5');
  });
});

describe('modelIdAddsInformation', () => {
  test('hides the ID when it is the display name in kebab-case', () => {
    // The exact pair from the report: two lines saying one thing.
    expect(modelIdAddsInformation('DeepSeek V4 Flash', 'deepseek-v4-flash')).toBe(false);
    expect(modelIdAddsInformation('DeepSeek V4 Pro 0813', 'deepseek-v4-pro-0813')).toBe(false);
    expect(modelIdAddsInformation('Claude Sonnet 4.5', 'claude-sonnet-4-5')).toBe(false);
  });

  test('ignores the provider prefix — the group heading already says it', () => {
    expect(modelIdAddsInformation('Claude Sonnet 4.5', 'anthropic/claude-sonnet-4-5')).toBe(false);
  });

  test('keeps the ID when it disambiguates a pinned snapshot', () => {
    expect(modelIdAddsInformation('GPT-5', 'gpt-5-2025-01-01')).toBe(true);
  });

  test('keeps the ID when the vendor string shares no stem with the name', () => {
    expect(modelIdAddsInformation('Kimi K2', 'moonshotai/kimi-k2-instruct')).toBe(true);
  });

  test('degrades safely on missing data', () => {
    expect(modelIdAddsInformation('Some Model', '')).toBe(false);
    expect(modelIdAddsInformation('', 'some-model')).toBe(true);
  });
});
