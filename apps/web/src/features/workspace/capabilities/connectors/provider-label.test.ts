import { describe, expect, test } from 'bun:test';

import { providerLabel } from './provider-label';

describe('providerLabel', () => {
  test('uses the regular plural Computers provider name', () => {
    expect(providerLabel('computer')).toBe('Computers');
  });
});
