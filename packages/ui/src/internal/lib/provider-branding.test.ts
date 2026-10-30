import { describe, expect, test } from 'bun:test';

import { providerIconSrc } from './provider-branding';

// Regression coverage for the models.dev id → logo mapping. The connect flow
// renders provider logos by their VERBATIM models.dev id (live catalog), so the
// map must be keyed on those ids — the old map keyed Bedrock/Fireworks on short
// aliases and pointed Moonshot (China) at a moonshotai-cn.svg that never
// existed, so those rows rendered a broken image.

describe('providerIconSrc', () => {
  test('resolves the featured models.dev provider ids to real assets', () => {
    expect(providerIconSrc('anthropic', '/provider-icons')).toBe('/provider-icons/anthropic.svg');
    expect(providerIconSrc('openai', '/provider-icons')).toBe('/provider-icons/openai.svg');
    expect(providerIconSrc('amazon-bedrock', '/provider-icons')).toBe('/provider-icons/amazon-bedrock.svg');
    expect(providerIconSrc('fireworks-ai', '/provider-icons')).toBe('/provider-icons/fireworks-ai.svg');
    expect(providerIconSrc('google-vertex', '/provider-icons')).toBe('/provider-icons/google.svg');
    expect(providerIconSrc('google-vertex-anthropic', '/provider-icons')).toBe('/provider-icons/anthropic.svg');
    expect(providerIconSrc('cohere-platform', '/provider-icons')).toBe('/provider-icons/cohere.svg');
    expect(providerIconSrc('opencode-go', '/provider-icons')).toBe('/provider-icons/opencode.svg');
  });

  test('renders the three distinct Moonshot providers with the Moonshot mark', () => {
    // All three share one mark (no separate -cn / kimi asset exists) but each is
    // a distinct provider id, and none may point at the non-existent
    // moonshotai-cn.svg.
    for (const id of ['moonshotai', 'moonshotai-cn', 'kimi-for-coding']) {
      expect(providerIconSrc(id, '/provider-icons')).toBe('/provider-icons/moonshotai.svg');
    }
  });

  test('without a host icon base, a mapped provider uses the models.dev logo of its icon', () => {
    expect(providerIconSrc('codex')).toBe('https://models.dev/logos/openai.svg');
    expect(providerIconSrc('bedrock')).toBe('https://models.dev/logos/amazon-bedrock.svg');
    expect(providerIconSrc('anthropic', 'https://cdn.example.test/icons')).toBe('https://cdn.example.test/icons/anthropic.svg');
  });

  test('keeps legacy short aliases working', () => {
    expect(providerIconSrc('bedrock', '/provider-icons')).toBe('/provider-icons/amazon-bedrock.svg');
    expect(providerIconSrc('fireworks', '/provider-icons')).toBe('/provider-icons/fireworks-ai.svg');
  });

  // A catalog provider without a bundled asset (hpc-ai, and ~150 others)
  // rendered initials built from the synthetic "Kortix" name: a "K" avatar.
  test('falls back to the models.dev logo for a catalog provider without a bundled asset', () => {
    expect(providerIconSrc('hpc-ai')).toBe('https://models.dev/logos/hpc-ai.svg');
  });

  // models.dev has no Platinum logo and answers with a generic sparkles mark;
  // ProviderLogo draws the Platinum square itself.
  test('never fetches a Platinum logo from models.dev', () => {
    expect(providerIconSrc('platinum')).toBeUndefined();
    expect(providerIconSrc('platinum', '/provider-icons')).toBeUndefined();
  });

  test('returns undefined for an id outside the catalog (caller falls back to initials)', () => {
    expect(providerIconSrc('some-brand-new-provider')).toBeUndefined();
  });
});
