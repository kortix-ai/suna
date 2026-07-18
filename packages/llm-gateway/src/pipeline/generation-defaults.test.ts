import { describe, expect, test } from 'bun:test';
import { applyGenerationDefaults } from './generation-defaults';

describe('applyGenerationDefaults', () => {
  test('returns the same body reference when there are no defaults', () => {
    const body = { model: 'x', messages: [] };
    expect(applyGenerationDefaults(body, undefined)).toBe(body);
  });

  test('returns the same body reference when defaults have nothing to add (all already set)', () => {
    const body = {
      model: 'x',
      temperature: 0.9,
      top_p: 0.5,
      max_tokens: 100,
      reasoning_effort: 'low',
    };
    const out = applyGenerationDefaults(body, {
      temperature: 0.1,
      topP: 0.1,
      maxOutputTokens: 10,
      reasoningEffort: 'high',
    });
    expect(out).toBe(body);
  });

  test('injects temperature/top_p/max_tokens/reasoning_effort when absent', () => {
    const body = { model: 'x', messages: [] };
    const out = applyGenerationDefaults(body, {
      temperature: 0.4,
      topP: 0.8,
      maxOutputTokens: 2048,
      reasoningEffort: 'medium',
    });
    expect(out).toEqual({
      model: 'x',
      messages: [],
      temperature: 0.4,
      top_p: 0.8,
      max_tokens: 2048,
      reasoning_effort: 'medium',
    });
  });

  test('an explicit client temperature always wins over the configured default', () => {
    const body = { model: 'x', temperature: 0.7 };
    const out = applyGenerationDefaults(body, { temperature: 0.1 });
    expect(out.temperature).toBe(0.7);
  });

  test('an explicit client top_p always wins over the configured default', () => {
    const body = { model: 'x', top_p: 0.3 };
    const out = applyGenerationDefaults(body, { topP: 0.99 });
    expect(out.top_p).toBe(0.3);
  });

  test('an explicit client max_completion_tokens blocks max_tokens injection', () => {
    const body = { model: 'x', max_completion_tokens: 500 };
    const out = applyGenerationDefaults(body, { maxOutputTokens: 4096 });
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBe(500);
  });

  test('an explicit nested reasoning.effort blocks flat reasoning_effort injection', () => {
    const body = { model: 'x', reasoning: { effort: 'low' } };
    const out = applyGenerationDefaults(body, { reasoningEffort: 'max' });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toEqual({ effort: 'low' });
  });

  test('only fills the fields the client omitted, leaving the rest untouched', () => {
    const body = { model: 'x', temperature: 0.7 };
    const out = applyGenerationDefaults(body, { temperature: 0.1, topP: 0.5 });
    expect(out).toEqual({ model: 'x', temperature: 0.7, top_p: 0.5 });
  });
});
