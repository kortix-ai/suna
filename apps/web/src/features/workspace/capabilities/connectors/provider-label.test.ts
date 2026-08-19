import { describe, expect, test } from 'bun:test';

import { providerLabel } from './provider-label';

describe('providerLabel', () => {
  test('uses the transport-specific Computer Tunnel provider name', () => {
    expect(providerLabel('computer')).toBe('Computer Tunnel');
  });
});
