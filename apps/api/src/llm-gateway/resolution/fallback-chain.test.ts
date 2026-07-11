import { describe, expect, test } from 'bun:test';
import { parseFallbackChain, resolveFallbackChain } from './fallback-chain';

describe('parseFallbackChain', () => {
  test('splits, trims, and de-dupes a comma-separated chain (order-preserving)', () => {
    expect(parseFallbackChain('claude-sonnet-4.6, glm-5.2 ,qwen3.7-max')).toEqual([
      'claude-sonnet-4.6',
      'glm-5.2',
      'qwen3.7-max',
    ]);
    expect(parseFallbackChain('a, a ,b,a')).toEqual(['a', 'b']);
  });

  test('a single value behaves exactly as before (backward compatible)', () => {
    expect(parseFallbackChain('claude-sonnet-4.6')).toEqual(['claude-sonnet-4.6']);
  });

  test('empty / undefined yields no chain', () => {
    expect(parseFallbackChain(undefined)).toEqual([]);
    expect(parseFallbackChain('')).toEqual([]);
    expect(parseFallbackChain('  , ,')).toEqual([]);
  });
});

describe('resolveFallbackChain', () => {
  test('keeps chain order, drops unservable models', () => {
    const servable = new Set(['claude-sonnet-4.6', 'qwen3.7-max']);
    expect(
      resolveFallbackChain(['claude-sonnet-4.6', 'glm-5.2', 'qwen3.7-max'], (id) =>
        servable.has(id),
      ),
    ).toEqual(['claude-sonnet-4.6', 'qwen3.7-max']);
  });

  test('all unservable yields an empty chain (BYOK descriptor alone, no fallover)', () => {
    expect(resolveFallbackChain(['glm-5.2'], () => false)).toEqual([]);
  });
});
