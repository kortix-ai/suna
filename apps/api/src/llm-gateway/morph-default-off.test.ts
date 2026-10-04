import { describe, expect, test } from 'bun:test';
import { MORPH_MANAGED_MODELS_DEFAULT, parseMorphManagedModels } from '../lib/config';

/**
 * Morph direct is off by default (2026-09-27). Its deepseek-v4.1-flash endpoint
 * ran at 78.9% uptime over 30 min on OpenRouter's public stats, and the
 * gateway fails over only on errors, never on a slow first byte, so users
 * waited 18-75 s per call. With no Morph route, managed models are served by
 * their OpenRouter pool. Re-enable per environment with MORPH_MANAGED_MODELS.
 */
describe('MORPH_MANAGED_MODELS', () => {
  test('defaults to no Morph route for any managed model', () => {
    expect(MORPH_MANAGED_MODELS_DEFAULT).toBe('');
    expect(parseMorphManagedModels(MORPH_MANAGED_MODELS_DEFAULT)).toEqual([]);
  });

  test('an explicit list still selects Morph per model', () => {
    expect(parseMorphManagedModels(' deepseek-v4.1-flash , kimi-k3,')).toEqual(['deepseek-v4.1-flash', 'kimi-k3']);
  });
});
