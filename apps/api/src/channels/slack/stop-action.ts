/**
 * The `action_id` the live plan's Stop button reports under.
 *
 * It lives in its own module because `stop.ts` imports `turn.ts` (for
 * `loadTurn` / `finalizeTurn`) and `turn.ts` needs the id to draw the button —
 * a plain constant breaks the cycle without a type-only import dance.
 */
export const SLACK_STOP_ACTION = 'stop_run';
