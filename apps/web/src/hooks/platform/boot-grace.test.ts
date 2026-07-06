import { describe, expect, test } from 'bun:test';

import { BOOT_GRACE_MS, isBootGraceExpired } from './boot-grace';

describe('sandbox boot-grace bound', () => {
  test('never expired while the runtime was last seen healthy (null clock)', () => {
    expect(isBootGraceExpired(null, 10_000_000)).toBe(false);
  });

  test('a genuine boot still inside the grace window is NOT stuck', () => {
    const start = 1_000_000;
    // Just under the window: still "booting", keep fast-polling.
    expect(isBootGraceExpired(start, start + BOOT_GRACE_MS - 1)).toBe(false);
    expect(isBootGraceExpired(start, start + BOOT_GRACE_MS)).toBe(false);
  });

  test('a 503-forever box past the grace window is treated as stuck', () => {
    const start = 1_000_000;
    // Past the window: stop hammering at 150ms, escalate to unreachable.
    expect(isBootGraceExpired(start, start + BOOT_GRACE_MS + 1)).toBe(true);
  });

  test('respects a custom grace window', () => {
    expect(isBootGraceExpired(0, 5_001, 5_000)).toBe(true);
    expect(isBootGraceExpired(0, 4_999, 5_000)).toBe(false);
  });
});
