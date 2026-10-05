/**
 * How long the global error boundary may hide a runtime-not-ready throw.
 *
 * `app/error.tsx` renders nothing for that throw and soft-resets every 800ms,
 * because the throw normally heals within a second or two of a session switch.
 * With no limit, a runtime that never comes up left a blank window forever.
 * On desktop that is a dead end: there is no browser Back and no reload button.
 *
 * `reset()` remounts the boundary on every retry, so component state cannot
 * hold the start time. The caller keeps one streak at module scope and records
 * a sighting on every retry tick. A gap longer than
 * `RUNTIME_NOT_READY_STREAK_GAP_MS` means the page rendered normally in
 * between, so the next outage starts a new streak with a full budget.
 */

/** Silent retry window. Far above the one-to-two-second session-switch race. */
export const RUNTIME_NOT_READY_BUDGET_MS = 30_000;

/** Longest pause between two sightings that still counts as one outage. */
export const RUNTIME_NOT_READY_STREAK_GAP_MS = 5_000;

export type RuntimeNotReadyStreak = { since: number; lastSeen: number };

/** Record one sighting at `now`, continuing `streak` or starting a new one. */
export function recordRuntimeNotReady(
  streak: RuntimeNotReadyStreak | null,
  now: number,
): RuntimeNotReadyStreak {
  if (!streak || now - streak.lastSeen > RUNTIME_NOT_READY_STREAK_GAP_MS) {
    return { since: now, lastSeen: now };
  }
  return { since: streak.since, lastSeen: now };
}

/** Whether the silent retry has run for the whole budget. */
export function isRuntimeNotReadyExhausted(streak: RuntimeNotReadyStreak, now: number): boolean {
  return now - streak.since >= RUNTIME_NOT_READY_BUDGET_MS;
}
