import type { ComposerSubmitIntent } from './editor/composer-editor';

/**
 * ENTER SENDS. CMD/CTRL+ENTER QUEUES. NEITHER ONE INTERRUPTS.
 *
 * This is the whole rule, and the part that is easy to get wrong is the last
 * sentence.
 *
 * A prompt is a durable inbox row from the moment the composer accepts it, and
 * the admission gate holds EVERY row until the running turn is over
 * (`apps/api/.../inbox-admission.ts`: "A LIVE TURN HOLDS EVERY QUEUED PROMPT
 * BACK … this is the one rule that makes a queued message its own turn with its
 * own answer"). Mid-turn forwarding was tried and reverted in `4ee30a9c3b`
 * because OpenCode merged the forwarded prompt into the running step: two
 * queued messages shared one answer and the earlier one was never spoken.
 *
 * So Enter ALREADY means "run this the moment the current answer finishes".
 * The current turn runs to completion; it is never aborted. An earlier build of
 * this file made Enter call `stopThenSendNow`, which KILLED the running turn.
 * That was wrong: it threw away work the user was waiting for, and Enter has
 * never meant that here.
 *
 * WHAT THE TWO KEYS ACTUALLY DECIDE IS WHERE THE PROMPT WAITS:
 *
 *  - `run` (Enter) — the prompt waits IN THE TRANSCRIPT, drawn as the dimmed
 *    user bubble it is about to become. One continuous fade: when a step opens
 *    under it, the same element comes up to full opacity. No second surface.
 *  - `queue` (Cmd/Ctrl+Enter) — the prompt is PARKED. It waits in the
 *    composer's queue list above the input, where it can be reordered, and it
 *    does not run until the user releases it.
 *
 * THEY DO NOT WAIT THE SAME WAY. An Enter row drains FIFO at the next turn
 * boundary. A parked row is born HELD server-side, with a 24h horizon
 * (`buildContinueSessionCommandValues`), and NEVER dispatches on its own: the
 * drain steps over it, `releaseInboxHold` deliberately skips it, and only the
 * row's own "Send now" (`retryInboxPrompt`) puts it back in line. "Both drain
 * FIFO at the next turn boundary" was true of an earlier build and is the
 * sentence to stop believing.
 *
 * THE SESSION HAS EXACTLY ONE INTERRUPT, AND IT IS THE STOP BUTTON.
 *
 * Not Enter, not Cmd+Enter, and not the queue row's "Send immediately" — that
 * one promotes a row to the front of the line and it goes out when the current
 * answer finishes, like everything else. A `stopThenSendNow` helper used to
 * abort the live turn for it; it was deleted, because jumping a queue that is
 * about to drain anyway is not worth the answer the user was waiting for.
 */

/** Does this submission park in the composer's reorderable queue list? */
export function isQueuedSubmission(intent: ComposerSubmitIntent): boolean {
  return intent === 'queue';
}

/**
 * Does pressing this key end the turn that is already running?
 *
 * NO — for either key, always. Kept as a named, tested constant rather than an
 * absent branch because "Enter interrupts" is the plausible-sounding reading
 * that was actually built once, and a reader deciding to add it should find
 * this and the reasoning above first.
 */
export const SUBMIT_INTERRUPTS_RUNNING_TURN = false;

/**
 * Does an Enter send jump the queue?
 *
 * NO — and note what that does and does not buy, because the obvious reading is
 * backwards. Rows drain in send order (`inboxSentAtSql` — `clientSentAtMs`,
 * then the wire id, then the row id), and nothing here promotes the newest send
 * above an older AUTO row. But an Enter send does run before every PARKED row,
 * always: a parked row is held out of the drain entirely, so there is no
 * ordering contest with it to win or lose. Parking is what "not before this
 * one" means; ordering is not.
 *
 * What this constant is really refusing is a queue-jumping rule of its own. The
 * per-row "send now" (`retryInboxPrompt`) remains the ONE way to promote a
 * specific message, because that is the one place the user names which.
 */
export const ENTER_PROMOTES_PAST_QUEUE = false;
