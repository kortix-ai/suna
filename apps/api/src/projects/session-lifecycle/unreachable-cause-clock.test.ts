/**
 * The durable `unreachable` cause must be cleared like every other readiness
 * field.
 *
 * The open stamps `opencodeUnreachableCause` on the sandbox row so a box that
 * has been cycling for an hour can be diagnosed from the row rather than from
 * a log line nobody can still reach. #7962 made the cause observable and
 * stopped at a `console.warn`, which left it unreadable from outside the
 * process — a diagnostic nobody can reach does not diagnose anything.
 *
 * But a cause left behind after a GOOD boot is a stale reading, and a stale
 * reading is worse than none. That is the exact trap this effort kept setting:
 * a turn error from 07:01 was read as a 12:12 failure; a readiness clock from a
 * previous attempt doomed the next one. So the cause is cleared by the same
 * sweep that clears every other readiness field.
 */

import { describe, expect, test } from 'bun:test';

import {
  IN_PLACE_RESTART_CLEARED_KEYS,
  RUNTIME_READINESS_CLOCK_KEYS,
} from './readiness-clocks';

describe('the durable unreachable cause', () => {
  test('is a readiness clock key, so every clearing path clears it', () => {
    expect(RUNTIME_READINESS_CLOCK_KEYS).toContain('opencodeUnreachableCause');
    expect(RUNTIME_READINESS_CLOCK_KEYS).toContain('opencodeUnreachableCauseAt');
  });

  test('is cleared by an in-place restart alongside the other clocks', () => {
    // The restart path clears a superset. If the cause were not in the base
    // list, a restarted box would keep claiming a failure it no longer has.
    expect(IN_PLACE_RESTART_CLEARED_KEYS).toContain('opencodeUnreachableCause');
    expect(IN_PLACE_RESTART_CLEARED_KEYS).toContain('opencodeUnreachableCauseAt');
  });

  test('the cause sits beside the clock it explains', () => {
    // `opencodeUnreachableWaitStartedAt` is WHEN; the cause is WHY. One without
    // the other is what made these boxes undiagnosable in the first place.
    expect(RUNTIME_READINESS_CLOCK_KEYS).toContain('opencodeUnreachableWaitStartedAt');
  });
});
