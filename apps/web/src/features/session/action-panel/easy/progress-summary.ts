/**
 * Pure formatting for the Progress card's collapsed subtitle.
 *
 * Kept separate from `progress-card.tsx` (a client component) purely so it is
 * unit-testable without a DOM. `Step.label` is already a finished
 * plain-language sentence — these helpers never touch it, only decide
 * *whether* to show it.
 */

import type { Step } from '../shared/group-steps';

function totalDurationMs(steps: Step[]): number {
  return steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
}

/** "42s" under a minute; "1m 04s" at or past a minute — seconds are always two digits once minutes appear. */
export function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.round(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

/** "1 step" / "12 steps", with "· 1m 04s" appended once any step carries timing. */
export function summarizeSteps(steps: Step[]): string {
  const count = steps.length;
  const noun = count === 1 ? 'step' : 'steps';
  const total = totalDurationMs(steps);
  return total > 0 ? `${count} ${noun} · ${formatDuration(total)}` : `${count} ${noun}`;
}

/**
 * The Progress card's one-line collapsed subtitle.
 *
 * While running, the current step's own label carries the story. Once idle
 * it settles into a calm summary. Zero steps still gets a true, calm
 * sentence — never a blank space that reads as broken.
 */
export function progressSubtitle(steps: Step[], isRunning: boolean): string {
  if (steps.length === 0) {
    return isRunning ? 'Just getting started' : 'Nothing to show yet';
  }
  if (isRunning) {
    return steps[steps.length - 1].label;
  }
  return summarizeSteps(steps);
}
