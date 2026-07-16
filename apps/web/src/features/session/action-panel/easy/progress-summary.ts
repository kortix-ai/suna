/**
 * Duration formatting for the Progress card.
 *
 * Kept separate from `progress-card.tsx` (a client component) purely so it is
 * unit-testable without a DOM.
 *
 * This file used to also summarize the step log ("12 steps · 1m 04s") and pick
 * the collapsed subtitle from it. Progress no longer shows a step log — it shows
 * the agent's own plan — so all of that went with it.
 */

/** "42s" under a minute; "1m 04s" at or past a minute — seconds are always two digits once minutes appear. */
export function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.round(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}
