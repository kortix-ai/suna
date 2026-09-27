import { beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetForcedRefreshCooldown,
  mayForceMirrorRefresh,
} from '../projects/routes/resource-grants';

/**
 * A grant for an agent committed seconds ago misses the timer-refreshed mirror,
 * and the route then forces one refresh. A burst of misses (a test suite, a
 * retrying client) must not become a burst of upstream git fetches.
 */
describe('mayForceMirrorRefresh', () => {
  beforeEach(() => __resetForcedRefreshCooldown());

  test('the first miss for a project may force a refresh', () => {
    expect(mayForceMirrorRefresh('p1', 1_000)).toBe(true);
  });

  test('a second miss inside the window may not', () => {
    expect(mayForceMirrorRefresh('p1', 1_000)).toBe(true);
    expect(mayForceMirrorRefresh('p1', 5_000)).toBe(false);
  });

  test('another project is not held back by the first', () => {
    expect(mayForceMirrorRefresh('p1', 1_000)).toBe(true);
    expect(mayForceMirrorRefresh('p2', 1_000)).toBe(true);
  });

  test('the window reopens', () => {
    expect(mayForceMirrorRefresh('p1', 1_000)).toBe(true);
    expect(mayForceMirrorRefresh('p1', 11_001)).toBe(true);
  });
});
