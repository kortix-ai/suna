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
 *
 * A turn WAITING ON THE USER is suppressed for the same reason as the error,
 * and it is the only one of these states with no upper bound. The runtime's
 * `question` tool and its permission prompts park the turn inside its own loop
 * and block until someone answers: no `session.idle` frame is emitted, the
 * control plane's turn row stays `active`, and every observer in
 * `projectWorking` is therefore correctly reporting `working`. The agent,
 * however, is not working — the next move is the reader's — so the shimmer and
 * its ticking clock claim progress that is not happening, directly above the
 * card asking them to act.
 *
 * MEASURED, local stack 2026-09-22 (session 8d807956): one prompt, the agent
 * answered and then asked a 2-option question. The control-plane row stayed
 * `active` for 12m22s while the question sat unanswered on screen, and the
 * transcript shimmered "Working on it" with a clock that reached 7m55s before
 * the screenshot was taken. Nothing would have ended it but answering — which
 * is what "loading forever" looks like from the other side of the screen.
 *
 * The composer already knows this (`lockForQuestion` / `lockForApproval` swap
 * Stop for the question's own control); this is the transcript catching up.
 */
export function showTurnBusyIndicator(input: {
  working: boolean;
  hasError: boolean;
  isRetrying: boolean;
  /**
   * The runtime is parked on an answer only the user can give — a pending
   * `question` request or a tool-permission prompt for this session.
   *
   * Outranks `isRetrying`: a retry countdown is the system working on its own
   * and is bounded by the ladder, while this is not bounded by anything.
   */
  awaitingUser?: boolean;
}): boolean {
  if (!input.working) return false;
  if (input.awaitingUser) return false;
  if (input.isRetrying) return true;
  return !input.hasError;
}
