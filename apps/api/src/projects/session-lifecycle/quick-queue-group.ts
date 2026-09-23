import { isHeldInboxRow } from './inbox-rows';
import { promptSteers } from './inbox-admission';
import { compareInboxSendOrder } from './inbox-order';
import type { SessionLifecycleCommandRow } from './store';

/**
 * ONE GROUP OF QUICK QUEUE PROMPTS IS ONE ANSWER.
 *
 * The owner's rule, 2026-09-21: "However many quick queue prompts are being
 * added, they should all be sent together to the agent, not one by one. If I
 * have 5 prompts in the quick queue they should all be sent together. On the UI
 * there won't be any change — they all look separate — but under the hood the
 * agent responds to them in a grouped format."
 *
 * WHY BATCHING IS SAFE NOW AND WAS NOT BEFORE. Plain `/prompt_async` starts a
 * reply for every message it takes, so two rows delivered back to back produced
 * two replies racing one transcript: "both rows reported delivered while the
 * first answer rendered under the second prompt" (the note on the drain's lane
 * loop in `engine.ts`), and the 2026-09-04 measurement where "tell me HI" and
 * "tell me bye" behind a 13-step turn produced exactly one reply, "bye". The
 * primitive that removes both failures is `noReply` on `/prompt_async`
 * (OpenCode 1.18.23, `SessionPromptAsyncData`): the user message is PERSISTED
 * and NO reply starts. A group of N therefore goes out as N-1 `noReply` posts
 * plus ONE ordinary post, and exactly one reply exists — parented on the LAST
 * message, with all N in context. There is no second reply to render under the
 * wrong prompt.
 *
 * WHAT MAY BE GROUPED. Only the Quick Queue lane (`placement: 'transcript'`,
 * the Enter key). Queue List (`placement: 'composer'`, Cmd/Ctrl+Enter) is a
 * queue by definition — one at a time, its own turn, its own answer — and a row
 * with NO placement (a first prompt, an automation, an older producer) is not a
 * correction to work in flight either. Both END a group rather than joining it,
 * so a group never reorders anything relative to them. Quick Queue already
 * sorts ahead of Queue List (`inbox-order.ts` lane 0 vs 1), so in canonical
 * send order a composer row can only ever fall AFTER the group.
 *
 * A HELD row is deliberately out of the line — the user pressed Stop on it — so
 * it is never grouped, and it ends the group rather than being skipped over:
 * skipping it would put the message after it on the wire ahead of a message the
 * user still intends to send.
 *
 * AND THE SAME IS TRUE OF A ROW THAT IS SIMPLY NOT IN THIS DRAIN'S HANDS. A
 * group is a CONTIGUOUS FIFO RUN of the session's transcript rows, never a set
 * of rows that happen to be in the batch — see `firstUnclaimed` on
 * {@link QuickQueueGroupOptions} for the measurement that proves it.
 */

/** Below this a group is an ordinary single delivery; see `quickQueueGroupHint`. */
export const QUICK_QUEUE_GROUP_HINT_MIN = 2;

/** May this row be merged into a grouped answer with its neighbours? */
export function isGroupableQuickQueueRow(row: SessionLifecycleCommandRow): boolean {
  return promptSteers(row) && !isHeldInboxRow(row.result);
}

export interface QuickQueueGroupOptions {
  /**
   * The EARLIEST inbox row of this session the drain does NOT hold
   * (`claimDueSessionInboxSiblings`' `firstUnclaimed`).
   *
   * A GROUP IS A CONTIGUOUS FIFO RUN, NOT A SET OF ROWS THAT HAPPEN TO BE IN
   * HAND. The batch alone cannot tell the two apart: it is whatever the claim
   * returned, and a row missing from the middle of it looks exactly like a row
   * that was never sent. Measured 2026-09-22, 2 of 2 runs — three Quick Queue
   * prompts ended one streaming response, each was put back on its own clock
   * (`available_at` 47.730 / 49.224 / 47.496 s), the 1 s scheduler drain took
   * only the two that were due, and rows 1 and 3 were merged into one grouped
   * answer ACROSS row 2. Row 2 went out ~3 s later, out of send order, and one
   * prompt was never answered.
   *
   * So the run ends at the gap. The rows after it stay in line, in order, and
   * the head that is left is refused by the admission gate's
   * `older_prompt_pending` if the gap is ahead of it — nothing ever jumps a row
   * the user still intends to send.
   */
  firstUnclaimed?: Pick<
    SessionLifecycleCommandRow,
    'commandId' | 'payload' | 'createdAt'
  > | null;
}

/**
 * The leading CONTIGUOUS run of groupable Quick Queue rows, or the head alone.
 *
 * `batch` must already be in canonical send order (`compareInboxSendOrder`).
 * The result is always a PREFIX of it, so the rows this delivery does not take
 * stay in line, in order, for the next one.
 */
export function quickQueueGroup(
  batch: readonly SessionLifecycleCommandRow[],
  options: QuickQueueGroupOptions = {},
): SessionLifecycleCommandRow[] {
  const gap = options.firstUnclaimed ?? null;
  let size = 0;
  while (size < batch.length && isGroupableQuickQueueRow(batch[size])) {
    if (gap && compareInboxSendOrder(batch[size], gap) > 0) break;
    size += 1;
  }
  return size >= QUICK_QUEUE_GROUP_HINT_MIN ? batch.slice(0, size) : batch.slice(0, 1);
}

/**
 * The hidden instruction row N of a group carries, as a `synthetic: true` text
 * part — wire-internal, never rendered (`session-transcript-compact.ts` filters
 * `!p.synthetic`, and so does the web user bubble at
 * `apps/web/src/features/session/turn/user-message.tsx`).
 *
 * WITHOUT IT THE MODEL ANSWERS ONLY THE LAST MESSAGE. Measured 2026-09-04: two
 * user messages reached one step and the reply spoke to the second one only —
 * "tell me HI" was never said. Merging is now deliberate rather than accidental,
 * so the merge is stated to the model instead of being left to it.
 */
export function quickQueueGroupHint(groupSize: number): string | null {
  if (groupSize < QUICK_QUEUE_GROUP_HINT_MIN) return null;
  return `The user sent ${groupSize} messages in a row. Treat them as one request and address every one of them in this reply, in order.`;
}

/**
 * Did any row of this delivery END a streaming response to get here?
 *
 * The marker is `result.ended_response`, stamped by `requeueForAdmission` in the
 * SAME durable write that puts the row back in line before the daemon is told
 * to end the turn — so it survives the pod that armed the interrupt. In a group
 * the row that ended the response is the first one, and the row that opens the
 * reply is the last; the question is therefore asked of the whole group.
 */
export function groupEndedResponse(group: readonly Pick<SessionLifecycleCommandRow, 'result'>[]): boolean {
  return group.some(
    (row) => (row.result as { ended_response?: unknown } | null)?.ended_response === true,
  );
}

/**
 * Did this row WAIT — was it put back by the admission gate, or already POSTed
 * once — so that its delivery must mint a wire id ABOVE the transcript?
 *
 * `payload.remintOnDelivery` is the durable half and `result.admission_reason`
 * the display half; `retryInboxPrompt` clears the display half on exactly the
 * row that waited longest, which is why both are read.
 */
export function inboxRowWaited(
  row: Pick<SessionLifecycleCommandRow, 'payload' | 'result'>,
): boolean {
  return (
    (row.payload as { remintOnDelivery?: unknown } | null)?.remintOnDelivery === true ||
    typeof (row.result as { admission_reason?: unknown } | null)?.admission_reason === 'string'
  );
}

/**
 * A GROUP MINTS AS ONE: if ANY row of it waited, EVERY row of it re-mints.
 *
 * A row that waited is LIFTED above the transcript tip (`mintLivePlacement`) —
 * far above every client id. A row claimed fresh beside it keeps the id the
 * client minted when the user pressed Enter. Put those two in one group and the
 * later message goes out UNDER the earlier one, and the SDK orders placed
 * messages by id: the tab draws the group's messages swapped.
 *
 * Measured 2026-09-22 on a real sandbox (session 37eb6e96, three Quick Queue
 * prompts over a streaming essay). Group [Request 1, Request 2]: Request 1 had
 * waited out the interrupt and was lifted to `msg_0ca6ad25f0002V…`; Request 2
 * was fresh and went out under its client id `msg_0ca6a8a77003Qo…`, which sorts
 * BELOW it. Both were answered, in one reply; the transcript showed them in the
 * wrong order.
 *
 * The re-mint floors on every id the inbox has already put on the wire
 * (`readDeliveredWireIdFloor`, read per row and after the previous row's id is
 * persisted), so lifting the whole group leaves it strictly ascending in send
 * order. A group where nothing waited keeps every client id, exactly as a
 * single fresh delivery does.
 */
export function groupRemintsTogether(
  group: readonly Pick<SessionLifecycleCommandRow, 'payload' | 'result'>[],
): boolean {
  return group.length >= QUICK_QUEUE_GROUP_HINT_MIN && group.some(inboxRowWaited);
}

/**
 * The hidden note for a reply that follows a response the user stopped.
 *
 * WITHOUT IT THE MODEL RESUMES WHAT IT WAS STOPPED IN. Measured 2026-09-21 on a
 * real sandbox: a 20-paragraph essay was ended by five Quick Queue prompts; the
 * grouped reply answered all five, then restarted the essay from "P1:" and
 * wrote for two more minutes. The aborted request is still unanswered work in
 * the model's context, and nothing said the interruption was deliberate. Typing
 * over a streaming answer means "stop that" — so that is stated.
 */
export function quickQueueInterruptNote(endedResponse: boolean): string | null {
  if (!endedResponse) return null;
  return 'The user stopped your previous reply on purpose by sending this. Do not resume, restart, or finish that reply unless they ask you to.';
}
