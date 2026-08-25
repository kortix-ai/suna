import { describe, expect, test } from 'bun:test';

import { catalogModelForGateway } from './generation-controls';

describe('catalogModelForGateway — client-side capability lookup', () => {
  test('resolves a BYOK provider/model id', () => {
    const model = catalogModelForGateway('openai/gpt-5.6-sol');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
    expect(model?.reasoning_options?.[0]?.values).toContain('xhigh');
  });

  test('resolves a codex/<id> wire model via the underlying openai/<id> entry', () => {
    const model = catalogModelForGateway('codex/gpt-5.6-sol');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
  });

  // MUST-FIX regression (adversarial review of PR #4995): a managed model's
  // `pricingRef` mismatching its models.dev catalog id makes this lookup
  // silently miss and fall back to the permissive synthetic record
  // (temperature:true, no reasoning_options). 2026-08-10 slim-down: the Claude
  // ids this test used are deactivated; deepseek-v4-flash keeps the regression
  // covered — its pricingRef ('openrouter/deepseek/deepseek-v4-flash') must hit
  // the REAL openrouter entry, whose 'high'/'xhigh' effort ladder the synthetic
  // fallback would never carry.
  test('resolves deepseek-v4-flash to its REAL catalog entry, not the synthetic fallback', () => {
    const model = catalogModelForGateway('deepseek-v4-flash');
    expect(model).toBeDefined();
    expect(model?.id).toBe('deepseek/deepseek-v4-flash');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(true);
    // models.dev publishes a `toggle` entry alongside the effort ladder for
    // this model, so find the effort knob rather than assuming index 0. The
    // synthetic fallback carries no reasoning_options at all.
    const effort = model?.reasoning_options?.find((option) => option.type === 'effort');
    expect(effort?.values?.length).toBeGreaterThan(1);
    expect(effort?.values).toContain('high');
  });

  test('a deactivated managed id (claude-opus-4.8) no longer resolves', () => {
    expect(catalogModelForGateway('claude-opus-4.8')).toBeUndefined();
  });

  test('does not resolve the removed synthetic auto model', () => {
    expect(catalogModelForGateway('auto')).toBeUndefined();
  });

  test('returns undefined for an unknown wire model', () => {
    expect(catalogModelForGateway('nonexistent-provider/nonexistent-model')).toBeUndefined();
  });
});
