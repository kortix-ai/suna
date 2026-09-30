import { describe, expect, test } from 'bun:test';

import { providerIconSrc } from './provider-branding';

// Regression coverage for the models.dev id → logo mapping. The connect flow
// renders provider logos by their VERBATIM models.dev id (live catalog), so the
// map must be keyed on those ids — the old map keyed Bedrock/Fireworks on short
// aliases and pointed Moonshot (China) at a moonshotai-cn.svg that never
// existed, so those rows rendered a broken image.

describe('providerIconSrc', () => {
  test('resolves the featured models.dev provider ids to real assets', () => {
    expect(providerIconSrc('anthropic')).toBe('/provider-icons/anthropic.svg');
    expect(providerIconSrc('openai')).toBe('/provider-icons/openai.svg');
    expect(providerIconSrc('amazon-bedrock')).toBe('/provider-icons/amazon-bedrock.svg');
    expect(providerIconSrc('fireworks-ai')).toBe('/provider-icons/fireworks-ai.svg');
    expect(providerIconSrc('google-vertex')).toBe('/provider-icons/google.svg');
    expect(providerIconSrc('google-vertex-anthropic')).toBe('/provider-icons/anthropic.svg');
    expect(providerIconSrc('cohere-platform')).toBe('/provider-icons/cohere.svg');
    expect(providerIconSrc('opencode-go')).toBe('/provider-icons/opencode.svg');
  });

  test('renders the three distinct Moonshot providers with the Moonshot mark', () => {
    // All three share one mark (no separate -cn / kimi asset exists) but each is
    // a distinct provider id, and none may point at the non-existent
    // moonshotai-cn.svg.
    for (const id of ['moonshotai', 'moonshotai-cn', 'kimi-for-coding']) {
      expect(providerIconSrc(id)).toBe('/provider-icons/moonshotai.svg');
    }
  });

  test('keeps legacy short aliases working', () => {
    expect(providerIconSrc('bedrock')).toBe('/provider-icons/amazon-bedrock.svg');
    expect(providerIconSrc('fireworks')).toBe('/provider-icons/fireworks-ai.svg');
  });

  // A catalog provider without a bundled asset (OpenCode Go, and ~150 others)
  // rendered initials built from the synthetic "Kortix" name: a "K" avatar.
  test('falls back to the models.dev logo for a catalog provider without a bundled asset', () => {
    expect(providerIconSrc('opencode-go')).toBe('https://models.dev/logos/opencode-go.svg');
  });

  test('returns undefined for an id outside the catalog (caller falls back to initials)', () => {
    expect(providerIconSrc('some-brand-new-provider')).toBeUndefined();
  });
});
