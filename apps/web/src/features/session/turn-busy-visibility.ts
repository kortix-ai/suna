/**
 * Does this turn still show the working indicator ("Figuring out what's
 * next…", the dot matrix, the live duration)?
 *
 * A turn that has reported an error is OVER: `session.error` terminates the
 * turn the runtime was running. Rendering the spinner beside the failure says
 * two contradictory things at once, and it is what the 2026-08-19 report
 * showed — a `ModelNotFound` line pinned under a spinner that never stopped,
 * because the turn's authority (a `GET .../turn` read of a control-plane row
 * the daemon had not yet closed) still reported the turn open.
 *
 * The one exception is a RETRY. The gateway's retry state is an error that has
 * not finished: the session status is `retry`, the countdown
 * (`SessionRetryDisplay`) renders inside this same block, and the turn really
 * is still going. So an error suppresses the indicator only when nothing is
 * being retried.
 */
export function showTurnBusyIndicator(input: {
  working: boolean;
  hasError: boolean;
  isRetrying: boolean;
}): boolean {
  if (!input.working) return false;
  if (input.isRetrying) return true;
  return !input.hasError;
}
