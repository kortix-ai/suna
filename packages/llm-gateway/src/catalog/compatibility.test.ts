import { describe, expect, test } from 'bun:test';

import { providerKindForNpm } from './compatibility';

describe('providerKindForNpm — default-to-openai-compat dispatch', () => {
  test('the two genuinely-different wire formats keep their own kind', () => {
    expect(providerKindForNpm('@ai-sdk/anthropic')).toBe('anthropic');
    expect(providerKindForNpm('@ai-sdk/amazon-bedrock')).toBe('bedrock');
  });

  test('Google (direct + Vertex) has no transport yet — explicitly unroutable, not silently openai-compat', () => {
    expect(providerKindForNpm('@ai-sdk/google')).toBeNull();
    expect(providerKindForNpm('@ai-sdk/google-vertex')).toBeNull();
    expect(providerKindForNpm('@ai-sdk/google-vertex/anthropic')).toBeNull();
  });

  test('the confirmed-common openai-compatible packages resolve to openai-compat', () => {
    for (const npm of [
      '@ai-sdk/openai-compatible',
      '@ai-sdk/openai',
      '@ai-sdk/groq',
      '@ai-sdk/mistral',
      '@ai-sdk/xai',
      '@openrouter/ai-sdk-provider',
    ]) {
      expect(providerKindForNpm(npm), npm).toBe('openai-compat');
    }
  });

  test('a brand-new, never-seen npm package defaults to openai-compat (zero-code-change robustness)', () => {
    expect(providerKindForNpm('@ai-sdk/some-provider-models-dev-adds-tomorrow')).toBe(
      'openai-compat',
    );
    expect(providerKindForNpm('totally-custom-ai-sdk-provider')).toBe('openai-compat');
  });

  test('no npm at all is unroutable', () => {
    expect(providerKindForNpm(null)).toBeNull();
    expect(providerKindForNpm(undefined)).toBeNull();
    expect(providerKindForNpm('')).toBeNull();
  });
});
