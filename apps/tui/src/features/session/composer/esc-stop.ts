/**
 * Esc ×3 stops a running turn. The same rule the web chat input follows
 * (`packages/ui/src/session/thread/session-chat.tsx`, "Triple-ESC to stop";
 * #11210): never a single-Escape stop, not even in an empty input.
 *
 * Pure so the counting rule is asserted without a renderer.
 */

/** Presses that stop the turn. */
export const ESC_STOP_PRESSES = 3;
/** The window, from the first press, inside which they must land. */
export const ESC_STOP_WINDOW_MS = 4000;

export interface EscCounter {
  count: number;
  /** When the first press of this run landed. */
  firstAtMs: number;
}

export const ESC_IDLE: EscCounter = { count: 0, firstAtMs: 0 };

/**
 * Count one Escape press. `stop` is true on the press that completes the run;
 * the counter then resets. A press after the window starts a new run.
 */
export function countEscape(
  counter: EscCounter,
  nowMs: number,
): { counter: EscCounter; stop: boolean; remaining: number } {
  const fresh = counter.count === 0 || nowMs - counter.firstAtMs > ESC_STOP_WINDOW_MS;
  const next: EscCounter = fresh
    ? { count: 1, firstAtMs: nowMs }
    : { count: counter.count + 1, firstAtMs: counter.firstAtMs };
  if (next.count >= ESC_STOP_PRESSES) return { counter: ESC_IDLE, stop: true, remaining: 0 };
  return { counter: next, stop: false, remaining: ESC_STOP_PRESSES - next.count };
}

/** The hint after a counted press that did not stop yet. */
export function escStopHint(remaining: number): string {
  return remaining === 1 ? 'Esc once more to stop' : `Esc ${remaining} more times to stop`;
}
