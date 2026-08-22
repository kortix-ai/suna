/**
 * Deterministic clock and randomness for the timeline golden.
 *
 * Import this module FIRST in any file that renders the golden fixture. The
 * turn card and its children read `Date.now()` for throttle seeds and
 * `Math.random()` for the busy indicator's ambient phrase; the golden is a
 * byte comparison, so both are pinned here and the time zone is fixed so any
 * `Intl` formatting lands the same on every machine.
 *
 * Importing freezes the clock at once — the one-shot capture script relies on
 * that. `bun test <dir>` runs every file of the directory in ONE process and
 * evaluates this module once, so a frozen `Date.now` would otherwise leak
 * into every later file (the composer draft store prunes by write time and
 * its "newest kept" test cannot tell fifty writes apart at one instant). A
 * test file therefore brackets its own tests: `beforeAll(freezeClock)` so
 * the clock is pinned even when an earlier file already restored it, and
 * `afterAll(restoreClock)` to hand the real clock back.
 */
process.env.TZ = 'UTC';

export const FIXED_NOW = Date.UTC(2026, 7, 12, 9, 34, 0);

const realNow = Date.now;
const realRandom = Math.random;

/** Pin `Date.now` to `FIXED_NOW` and `Math.random` to 0. Idempotent. */
export function freezeClock(): void {
  Date.now = () => FIXED_NOW;
  Math.random = () => 0;
}

/** Put the real `Date.now` and `Math.random` back. */
export function restoreClock(): void {
  Date.now = realNow;
  Math.random = realRandom;
}

freezeClock();
