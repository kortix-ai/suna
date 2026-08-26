/**
 * A corrupt or legacy `opencode-model-store-v1` localStorage entry must never
 * brick the app. Proven live on Essentia 2026-08-26: a malformed store value
 * crashed every route with the full-screen "Something went wrong — a.user is
 * not iterable" card, because loadStore() returned JSON.parse(raw) unvalidated
 * and consumers iterate `store.user`. The sanitizer guarantees the shape.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeModelStore } from './use-model-store';

const base = { user: [], recent: [], variant: {} };

describe('sanitizeModelStore', () => {
  test('null/undefined/non-object -> defaults', () => {
    expect(sanitizeModelStore(null)).toEqual(base);
    expect(sanitizeModelStore(undefined)).toEqual(base);
    expect(sanitizeModelStore('junk')).toEqual(base);
    expect(sanitizeModelStore(42)).toEqual(base);
  });

  test('the live crash shape: object missing user/recent arrays -> arrays restored', () => {
    const s = sanitizeModelStore({ selected: { 'native:': 'amazon-bedrock/xai.grok-4.6' } });
    expect(Array.isArray(s.user)).toBe(true);
    expect(Array.isArray(s.recent)).toBe(true);
    expect(s.variant).toEqual({});
  });

  test('wrong-typed fields are replaced, right-typed fields survive', () => {
    const s = sanitizeModelStore({
      user: { not: 'an array' },
      recent: 'nope',
      variant: [],
      selectedModel: { 'native:agent': { providerID: 'p', modelID: 'm' } },
      lastAgentName: 'kortix',
      globalDefault: { providerID: 'p', modelID: 'm' },
    });
    expect(s.user).toEqual([]);
    expect(s.recent).toEqual([]);
    expect(s.variant).toEqual({});
    expect(s.selectedModel).toEqual({ 'native:agent': { providerID: 'p', modelID: 'm' } });
    expect(s.lastAgentName).toBe('kortix');
    expect(s.globalDefault).toEqual({ providerID: 'p', modelID: 'm' });
  });

  test('a fully valid store passes through unchanged', () => {
    const valid = {
      user: [{ providerID: 'p', modelID: 'm', visibility: 'show' as const }],
      recent: [{ providerID: 'p', modelID: 'm' }],
      variant: { k: 'high' },
      sessionModel: { s1: { providerID: 'p', modelID: 'm' } },
      sessionAgentName: { s1: 'build' },
    };
    expect(sanitizeModelStore(valid)).toEqual(valid);
  });

  test('non-object entries inside arrays are dropped', () => {
    const s = sanitizeModelStore({ user: [null, 'x', { providerID: 'p', modelID: 'm', visibility: 'show' }], recent: [1, { providerID: 'p', modelID: 'm' }], variant: {} });
    expect(s.user).toHaveLength(1);
    expect(s.recent).toHaveLength(1);
  });
});
