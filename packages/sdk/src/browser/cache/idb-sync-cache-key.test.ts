import { describe, expect, test } from 'bun:test';

import { buildSessionCacheKey } from './idb-sync-cache-key';

describe('buildSessionCacheKey', () => {
  test('preserves the published legacy key when no platform scope exists', () => {
    expect(buildSessionCacheKey('user:account-1', 'ses_1')).toBe('user:account-1:session:ses_1');
  });

  test('separates equal OpenCode ids owned by different Kortix sessions', () => {
    const first = buildSessionCacheKey(
      'user:account-1',
      'ses_from_snapshot',
      'project-a/session-a',
    );
    const second = buildSessionCacheKey(
      'user:account-1',
      'ses_from_snapshot',
      'project-a/session-b',
    );

    expect(first).not.toBe(second);
  });

  test('keeps one Kortix session cache across an authoritative root change', () => {
    const before = buildSessionCacheKey('user:account-1', 'ses_stale', 'project-a/session-a');
    const after = buildSessionCacheKey(
      'user:account-1',
      'ses_authoritative',
      'project-a/session-a',
    );

    expect(before).toBe(after);
  });
});
