/**
 * Deterministic clock and randomness for the timeline golden.
 *
 * Import this module FIRST in any file that renders the golden fixture. The
 * legacy turn card and its children read `Date.now()` for throttle seeds and
 * `Math.random()` for the busy indicator's ambient phrase; the golden is a
 * byte comparison, so both are pinned here and the time zone is fixed so any
 * `Intl` formatting lands the same on every machine.
 */
process.env.TZ = 'UTC';

export const FIXED_NOW = Date.UTC(2026, 7, 12, 9, 34, 0);

Date.now = () => FIXED_NOW;
Math.random = () => 0;
