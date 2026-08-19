import { describe, expect, test } from 'bun:test';
import { START_INCONCLUSIVE_GIVE_UP_MS } from './use-session';
import { RUNTIME_BOOT_STALL_MS } from './use-runtime-boot-stalled';

/**
 * The two give-up clocks are ONE number.
 *
 * `RUNTIME_BOOT_STALL_MS` was a hand-copied `45_000` kept in sync with
 * `START_INCONCLUSIVE_GIVE_UP_MS` by a comment. They bound the same window from
 * two sides — `/start` staying inconclusive, and the runtime never turning
 * healthy — so a change to one that missed the other would make the composer's
 * "Waking this session up…" notice and the `/start` poll disagree about when a
 * boot has stopped being a boot. It is derived now; this asserts it stays that
 * way.
 */
describe('RUNTIME_BOOT_STALL_MS', () => {
  test('is the /start give-up ceiling, not a copy of it', () => {
    expect(RUNTIME_BOOT_STALL_MS).toBe(START_INCONCLUSIVE_GIVE_UP_MS);
  });
});
