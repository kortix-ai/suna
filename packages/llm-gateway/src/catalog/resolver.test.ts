import { describe, expect, test } from 'bun:test';

import { resolveCatalogUpstream } from './resolver';

describe('resolveCatalogUpstream', () => {
  test('resolves an openai-compatible provider to a proxyable upstream', () => {
    const up = resolveCatalogUpstream('groq');
    expect(up).not.toBeNull();
    expect(up?.kind).toBe('openai-compat');
    expect(up?.baseUrl).toMatch(/^https?:\/\//);
    expect(up?.envVar).toBeTruthy();
  });

  test('falls back to a known base URL when the catalog omits api (openai)', () => {
    const up = resolveCatalogUpstream('openai');
    expect(up?.baseUrl).toBe('https://api.openai.com/v1');
    expect(up?.envVar).toBe('OPENAI_API_KEY');
  });

  test('returns null for non-openai-compatible providers (anthropic)', () => {
    expect(resolveCatalogUpstream('anthropic')).toBeNull();
  });

  test('returns null for unknown providers', () => {
    expect(resolveCatalogUpstream('definitely-not-a-provider')).toBeNull();
  });
});
