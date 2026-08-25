import { describe, expect, test } from 'bun:test';

import { applyReasoningEffort, reasoningEffortValuesFor } from './reasoning-effort-selector';

describe('reasoningEffortValuesFor — composer show/hide source of truth', () => {
  test('no model selected → hidden', () => {
    expect(reasoningEffortValuesFor(undefined)).toEqual([]);
  });

  test('unknown wire model → hidden', () => {
    expect(reasoningEffortValuesFor('nonexistent-provider/nonexistent-model')).toEqual([]);
  });

  test('a reasoning model with explicit reasoning_options exposes its OWN values (never hardcoded)', () => {
    // Real catalog entry — same fixture `catalogModelForGateway` (#4995) is
    // tested against. gpt-5.6-sol's effort ladder includes xhigh/max, which a
    // generic low/medium/high fallback would never surface.
    const values = reasoningEffortValuesFor('openai/gpt-5.6-sol');
    expect(values.length).toBeGreaterThan(0);
    expect(values).toContain('xhigh');
  });

  test('the synthetic auto pseudo-model is never treated as reasoning-capable → hidden', () => {
    expect(reasoningEffortValuesFor('auto')).toEqual([]);
  });

  test('the picker model\'s OWN reasoning_options win over the web catalog — a model the baked seed has never heard of still gets its ladder', () => {
    const values = reasoningEffortValuesFor('amazon-bedrock/global.openai.gpt-9-brand-new', [
      { type: 'effort', values: ['none', 'low', 'high', 'max'] },
    ]);
    expect(values).toEqual(['none', 'low', 'high', 'max']);
  });

  test('picker reasoning_options with only a budget_tokens knob synthesize the standard tiers', () => {
    const values = reasoningEffortValuesFor('amazon-bedrock/some.claude', [
      { type: 'budget_tokens', min: 1024 },
    ]);
    expect(values.length).toBeGreaterThan(0);
    expect(values).toContain('high');
  });

  test('empty picker reasoning_options fall back to the web catalog (no fabricated ladder for an unknown model)', () => {
    expect(reasoningEffortValuesFor('nonexistent/model', [])).toEqual([]);
    expect(reasoningEffortValuesFor('openai/gpt-5.6-sol', null)).toContain('xhigh');
  });

  test('a Bedrock global inference profile resolves from the refreshed baked seed too', () => {
    expect(reasoningEffortValuesFor('amazon-bedrock/global.openai.gpt-5.6-sol')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  test('a managed model resolves through its pricingRef to real reasoning_options', () => {
    const values = reasoningEffortValuesFor('deepseek-v4-flash');
    expect(values).toEqual(['high', 'xhigh']);
  });
});

describe('applyReasoningEffort — the exact PUT-body merge the composer sends', () => {
  test('setting a value on an empty config creates just that model entry', () => {
    const next = applyReasoningEffort(undefined, 'openai/gpt-5.6-sol', 'high');
    expect(next).toEqual({ 'openai/gpt-5.6-sol': { reasoningEffort: 'high' } });
  });

  test('clearing (null) on an empty config is a no-op — no entry created', () => {
    const next = applyReasoningEffort(undefined, 'openai/gpt-5.6-sol', null);
    expect(next).toEqual({});
  });

  test('clearing the ONLY configured field drops the model key entirely', () => {
    const next = applyReasoningEffort(
      { 'openai/gpt-5.6-sol': { reasoningEffort: 'high' } },
      'openai/gpt-5.6-sol',
      null,
    );
    expect(next).toEqual({});
  });

  test('clearing reasoningEffort PRESERVES other generation-config fields already set for the model', () => {
    const next = applyReasoningEffort(
      { 'openai/gpt-5.6-sol': { reasoningEffort: 'high', maxOutputTokens: 4096 } },
      'openai/gpt-5.6-sol',
      null,
    );
    expect(next).toEqual({ 'openai/gpt-5.6-sol': { maxOutputTokens: 4096 } });
  });

  test('changing the value overwrites only reasoningEffort, keeps sibling fields', () => {
    const next = applyReasoningEffort(
      { 'openai/gpt-5.6-sol': { reasoningEffort: 'low', temperature: 0.4 } },
      'openai/gpt-5.6-sol',
      'xhigh',
    );
    expect(next).toEqual({ 'openai/gpt-5.6-sol': { reasoningEffort: 'xhigh', temperature: 0.4 } });
  });

  test('other models in the project config are left completely untouched', () => {
    const next = applyReasoningEffort(
      {
        'anthropic/claude-sonnet-4.6': { reasoningEffort: 'medium' },
        'openai/gpt-5.6-sol': { reasoningEffort: 'low' },
      },
      'openai/gpt-5.6-sol',
      'max',
    );
    expect(next).toEqual({
      'anthropic/claude-sonnet-4.6': { reasoningEffort: 'medium' },
      'openai/gpt-5.6-sol': { reasoningEffort: 'max' },
    });
  });
});
