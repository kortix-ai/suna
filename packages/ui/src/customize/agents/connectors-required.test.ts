import { describe, expect, test } from 'bun:test';

import { pruneRequiredConnectors, toggleRequiredConnector } from './connectors-required';

describe('pruneRequiredConnectors', () => {
  test('dropping a picked connector drops its Required flag', () => {
    expect(pruneRequiredConnectors(['github', 'slack'], ['github'])).toEqual(['github']);
  });

  test('switching to All or None clears the list', () => {
    expect(pruneRequiredConnectors(['github'], 'all')).toBeUndefined();
    expect(pruneRequiredConnectors(['github'], 'none')).toBeUndefined();
  });

  test('an unchanged list comes back as the same value, so nothing is written', () => {
    const required = ['github'];
    expect(pruneRequiredConnectors(required, ['github', 'slack'])).toBe(required);
    expect(pruneRequiredConnectors(undefined, 'all')).toBeUndefined();
  });
});

describe('toggleRequiredConnector', () => {
  test('adds, then removes, and an empty list leaves the key', () => {
    expect(toggleRequiredConnector(undefined, 'github')).toEqual(['github']);
    expect(toggleRequiredConnector(['github', 'slack'], 'github')).toEqual(['slack']);
    expect(toggleRequiredConnector(['github'], 'github')).toBeUndefined();
  });
});
