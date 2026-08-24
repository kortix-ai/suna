import { describe, expect, test } from 'bun:test';

import { transcriptIsFragment } from './fragment';

/**
 * The hole the IndexedDB removal (5a7a43517f) named and did not close:
 *
 *   "a session evicted while its agent runs comes back from SSE as a fragment;
 *    that repaint is gone here and no reconcile is keyed on eviction, so an
 *    evicted-then-refilled session can sit on a partial transcript until a
 *    reload."
 *
 * The store already carries the exact signature. Eviction drops a detached
 * session's messages AND marks the id; every path that re-establishes the
 * session authoritatively — `hydrate`, `clearSession`, `optimisticAdd` — clears
 * the mark. `applyEvent` does NOT. So a session that HOLDS MESSAGES while still
 * MARKED EVICTED was refilled by the live stream alone: it has the frames that
 * arrived since eviction and nothing before them. That is a fragment, by
 * construction, and it is the one state a tail read must repair.
 */
describe('transcriptIsFragment', () => {
  test('messages rebuilt by the stream after an eviction are a fragment', () => {
    expect(transcriptIsFragment({ hasMessages: true, wasEvicted: true })).toBe(true);
  });

  test('an evicted session holding nothing is empty, not partial', () => {
    // Nothing to repair and nothing to mislead: the mount path loads the tail.
    expect(transcriptIsFragment({ hasMessages: false, wasEvicted: true })).toBe(false);
  });

  test('an authoritative load is never a fragment — hydrate clears the mark', () => {
    expect(transcriptIsFragment({ hasMessages: true, wasEvicted: false })).toBe(false);
  });

  test('a session nobody ever evicted is never a fragment', () => {
    expect(transcriptIsFragment({ hasMessages: false, wasEvicted: false })).toBe(false);
  });
});
