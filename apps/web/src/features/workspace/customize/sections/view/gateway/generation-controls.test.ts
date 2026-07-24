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

  // MUST-FIX regression (adversarial review of PR #4995): `claude-opus-4.8`'s
  // `pricingRef` used to be the DOTTED display id ('anthropic/claude-opus-4.8'),
  // which never matches models.dev's DASHED catalog id ('claude-opus-4-8') —
  // so this lookup silently missed and fell back to the permissive synthetic
  // record below (temperature:true, no reasoning_options). It must now hit
  // the model's REAL catalog entry: temperature:false, and reasoning_options
  // including the newer 'xhigh'/'max' tiers.
  test('resolves claude-opus-4.8 to its REAL catalog entry, not the synthetic fallback', () => {
    const model = catalogModelForGateway('claude-opus-4.8');
    expect(model).toBeDefined();
    expect(model?.id).toBe('claude-opus-4-8');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
    expect(model?.reasoning_options?.[0]?.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('resolves claude-sonnet-4.6 to its REAL catalog entry, not the synthetic fallback', () => {
    const model = catalogModelForGateway('claude-sonnet-4.6');
    expect(model).toBeDefined();
    expect(model?.id).toBe('claude-sonnet-4-6');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(true);
    expect(model?.reasoning_options?.[0]?.values).toEqual(['low', 'medium', 'high', 'max']);
  });

  test('does not resolve the removed synthetic auto model', () => {
    expect(catalogModelForGateway('auto')).toBeUndefined();
  });

  test('returns undefined for an unknown wire model', () => {
    expect(catalogModelForGateway('nonexistent-provider/nonexistent-model')).toBeUndefined();
  });
});
