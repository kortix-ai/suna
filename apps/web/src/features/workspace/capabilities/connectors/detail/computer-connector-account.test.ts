import { describe, expect, test } from 'bun:test';

import { computerTunnelId } from './computer-connector-account';

describe('computerTunnelId', () => {
  test('reads the immutable tunnel UUID from a per-machine connector slug', () => {
    expect(computerTunnelId('computer-11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  test('rejects the retired aggregate slug and malformed profile slugs', () => {
    expect(computerTunnelId('computer')).toBeNull();
    expect(computerTunnelId('computer-not-a-uuid')).toBeNull();
  });
});
