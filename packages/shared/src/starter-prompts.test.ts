import { describe, expect, test } from 'bun:test';
import { STARTER_PROMPT_FALLBACKS, type StarterPromptText } from './starter-prompts';

describe('starter prompts', () => {
  test('6 entries in STARTER_PROMPT_FALLBACKS', () => {
    expect(STARTER_PROMPT_FALLBACKS).toHaveLength(6);
  });

  test('every entry has a unique id', () => {
    const ids = STARTER_PROMPT_FALLBACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every label is 60 chars or fewer', () => {
    for (const prompt of STARTER_PROMPT_FALLBACKS) {
      expect(prompt.label.length).toBeLessThanOrEqual(60);
    }
  });

  test('every prompt is non-empty and 400 chars or fewer', () => {
    for (const prompt of STARTER_PROMPT_FALLBACKS) {
      expect(prompt.prompt.length).toBeGreaterThan(0);
      expect(prompt.prompt.length).toBeLessThanOrEqual(400);
    }
  });
});
