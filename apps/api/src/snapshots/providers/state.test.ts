import { describe, expect, test } from 'bun:test';
import { normalizeExistingProviderState } from './state';

describe('unified sandbox template provider state', () => {
  test.each([
    ['active', 'active'], // Daytona
    ['ready', 'active'], // Platinum + E2B
    ['building', 'building'],
    ['pulling', 'building'],
    ['queued', 'building'],
    ['pending', 'building'],
    ['', 'building'],
    [undefined, 'building'],
    ['error', 'build_failed'],
    ['failed', 'build_failed'],
    ['build_failed', 'build_failed'],
    ['cancelled', 'build_failed'],
    ['removing', 'removing'],
    ['deleting', 'removing'],
  ] as const)('%s becomes %s', (providerState, expected) => {
    expect(normalizeExistingProviderState(providerState)).toBe(expected);
  });
});
