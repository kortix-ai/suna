import { describe, expect, test } from 'bun:test';

import { sessionsNeedingRehydrate } from './rehydrate-targets';

describe('sessionsNeedingRehydrate', () => {
  /**
   * The rule this replaced filtered on the status slot — which the stream
   * fills. A gap that loses message frames loses status frames too, so the
   * sessions most likely to be stale were exactly the ones skipped.
   */
  test('after a gap every held transcript is re-read, whatever its status slot says', () => {
    expect(sessionsNeedingRehydrate(['idle-one', 'busy-one'])).toEqual(['idle-one', 'busy-one']);
  });

  test('a session held twice is read once', () => {
    expect(sessionsNeedingRehydrate(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  test('nothing held, nothing read', () => {
    expect(sessionsNeedingRehydrate([])).toEqual([]);
  });
});
