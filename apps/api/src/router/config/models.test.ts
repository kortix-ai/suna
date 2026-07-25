import { describe, expect, test } from 'bun:test';

import { getModel, requireModelPricing, resolveOpenRouterId } from './models';

describe('billable model resolution', () => {
  test('returns null for a provider/model pair without an exact price', () => {
    expect(getModel('provider/unknown-model', 'openrouter')).toBeNull();
  });

  test('rejects a provider/model pair without an exact price', () => {
    expect(() => requireModelPricing('provider/unknown-model', 'openrouter')).toThrow(
      'No billing price for openrouter/provider/unknown-model',
    );
  });

  test('resolves an OpenRouter transport id without inventing a billing price', () => {
    expect(resolveOpenRouterId('openrouter/provider/unknown-model')).toBe('provider/unknown-model');
  });
});
