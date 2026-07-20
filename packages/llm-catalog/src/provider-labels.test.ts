import { describe, expect, test } from 'bun:test';

import { MODEL_SELECTOR_PROVIDER_IDS, PROVIDER_LABELS } from './index';

// The session model picker groups gateway models by their REAL upstream
// provider id (`GatewayModel.provider`) and resolves the group's display label
// through PROVIDER_LABELS, falling back to the model's own `providerName` —
// which under the gateway is ALWAYS "Kortix", because every gateway model is
// registered under one synthetic `kortix` opencode provider.
//
// So a MISSING entry here does not degrade gracefully: it silently mislabels a
// whole provider group as "Kortix". That is exactly what happened to BYOK
// Bedrock — models.dev's canonical id is `amazon-bedrock`, but only the short
// `bedrock` alias was mapped.
describe('PROVIDER_LABELS', () => {
  test('maps the canonical models.dev Bedrock id used on the wire', () => {
    expect(PROVIDER_LABELS['amazon-bedrock']).toBe('Amazon Bedrock');
  });

  test('maps the short `bedrock` alias to the same label', () => {
    expect(PROVIDER_LABELS.bedrock).toBe('Amazon Bedrock');
  });

  // The map is deliberately CURATED, not exhaustive over models.dev's ~100+
  // providers — unknown long-tail ids fall back to the model's providerName by
  // design. But every id the picker itself promotes must resolve, or that
  // fallback silently prints "Kortix".
  test('every provider id the model selector promotes has a label', () => {
    const missing = MODEL_SELECTOR_PROVIDER_IDS.filter((id) => !PROVIDER_LABELS[id]);
    expect(missing).toEqual([]);
  });
});
