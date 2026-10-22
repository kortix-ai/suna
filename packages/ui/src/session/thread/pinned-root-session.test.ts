import { describe, expect, test } from 'bun:test';

import { resolvePinnedRootSessionId } from './pinned-root-session';

describe('resolvePinnedRootSessionId', () => {
  test('latches the first resolved id', () => {
    expect(resolvePinnedRootSessionId(null, 'ses_a')).toBe('ses_a');
  });

  test('keeps the latch through a null blip — the reason the latch exists', () => {
    expect(resolvePinnedRootSessionId('ses_a', null)).toBe('ses_a');
  });

  test('a DIFFERENT resolved id displaces the latch — the /start pin is authoritative', () => {
    // The pin precedence only climbs (persisted mirror → network row →
    // /start), so a non-null change is always a higher-authority correction.
    // Keeping the stale latch painted — and delivered prompts into — the
    // conversation the stale pin named.
    expect(resolvePinnedRootSessionId('ses_stale', 'ses_fresh')).toBe('ses_fresh');
  });

  test('the same id is a no-op', () => {
    expect(resolvePinnedRootSessionId('ses_a', 'ses_a')).toBe('ses_a');
  });

  test('nothing resolved yet stays unlatched', () => {
    expect(resolvePinnedRootSessionId(null, null)).toBeNull();
  });
});
