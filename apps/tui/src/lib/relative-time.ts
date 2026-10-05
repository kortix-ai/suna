/**
 * The sidebar's right-hand age column.
 *
 * Fixed-width by construction (at most 4 columns: `now`, `59m`, `23h`, `29d`,
 * `11mo`, `9y`) so a row never reflows when a session's age ticks over. The
 * unit ladder mirrors `shortRelative` in
 * `apps/web/src/features/workspace/project-sidebar/project-session-list-helpers.ts`
 * so a session reads the same in both clients.
 *
 * Pure: `now` is a parameter, never `Date.now()`.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The month/year steps are display buckets, not calendar arithmetic. */
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * `fromMs` rendered as an age against `nowMs`.
 *
 * A future or unparseable timestamp reads `now` rather than a negative age:
 * clock skew between the API and this terminal is real, and `-3m` is worse
 * than a rounding error.
 */
export function relativeAge(fromMs: number, nowMs: number): string {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return '';
  const delta = nowMs - fromMs;
  if (delta < MINUTE_MS) return 'now';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h`;
  if (delta < MONTH_MS) return `${Math.floor(delta / DAY_MS)}d`;
  if (delta < YEAR_MS) return `${Math.floor(delta / MONTH_MS)}mo`;
  return `${Math.floor(delta / YEAR_MS)}y`;
}
