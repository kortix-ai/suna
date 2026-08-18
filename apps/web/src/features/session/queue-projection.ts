import type { SessionPrompt } from '@kortix/sdk';

/**
 * What the composer's queue strip renders, from the ONE thing that holds a
 * pending message.
 *
 * The server inbox (`GET .../prompts`) is the queue: durable, shared across
 * tabs and devices, ordered and admitted by the control plane. Every prompt
 * goes there.
 *
 * This function used to merge that list with a second, browser-local one, and
 * every row carried its ORIGIN so each action could address the store that
 * actually held it. The browser store is gone — with it the localStorage blob a
 * closed tab lost, the drain that guessed at turn boundaries from a debounced
 * `isBusy`, and the two-lane ordering problem that needed a `serverPromptPending`
 * gate to stop both lanes firing at the same boundary. What is left is a
 * projection of one list, which is why there is no `source` and no `localIds`.
 */

export interface QueueRow {
  id: string;
  text: string;
  lastError?: string;
}

export interface QueueProjection {
  /** Every row still waiting to be answered, in delivery order — including the
   *  ones already on the wire. */
  queued: QueueRow[];
  /** Rows that gave up and offer a retry. */
  failed: QueueRow[];
  /** Which of `queued` are on the wire: rendered, but not editable, not
   *  removable, not reorderable. */
  inFlightIds: string[];
  /** The queue is held by a stop — see `holdSessionPrompts`. */
  held: boolean;
}

export function projectQueueRows(input: {
  prompts: SessionPrompt[];
  /**
   * Every message id the transcript is already showing — the optimistic bubble
   * included. A row whose message is on screen as a message is not a queue row.
   *
   * Optional so a caller with no transcript (tests, the strip in isolation)
   * gets the raw projection.
   */
  transcriptMessageIds?: ReadonlySet<string>;
}): QueueProjection {
  const queued: QueueRow[] = [];
  const failed: QueueRow[] = [];
  const inFlightIds: string[] = [];
  let held = false;

  for (const prompt of input.prompts) {
    const row: QueueRow = {
      id: prompt.prompt_id,
      text: prompt.text,
      ...(prompt.last_error ? { lastError: prompt.last_error } : {}),
    };
    if (prompt.reason === 'held') held = true;
    if (prompt.state === 'failed') {
      failed.push(row);
      continue;
    }
    // ALREADY ON SCREEN AS A MESSAGE. Rendering `delivering` rows fixed one
    // half of the problem — a mid-turn prompt with nothing else holding it —
    // and opened the other: an idle send paints its optimistic bubble at once,
    // and a mid-turn one arrives over SSE the moment OpenCode persists it, so
    // from then on the same text is both a streaming answer and a pending queue
    // row. The transcript wins; the strip is for what is NOT in it yet.
    //
    // A HELD row is the exception, and it is the whole reason this is not a
    // blanket filter: a stop-paused prompt IS in the transcript, unanswered and
    // parked, and the strip is the only place its remove and "send now"
    // controls exist.
    if (
      prompt.reason !== 'held' &&
      prompt.message_id &&
      input.transcriptMessageIds?.has(prompt.message_id)
    ) {
      continue;
    }
    // A DELIVERING row is a queue row too. The server forwards a prompt typed
    // mid-turn within seconds, and it then reads `delivering` for the whole of
    // the turn in front of it — minutes, and the p99 turn is over an hour.
    // Nothing paints it into the transcript in the meantime
    // (`willWaitInInbox`), so dropping it here is the user's message vanishing
    // from the screen. It is listed as in-flight so the row renders INERT:
    // every action the strip offers is refused by the server for a row it has
    // already handed to OpenCode.
    if (prompt.state === 'delivering') inFlightIds.push(prompt.prompt_id);
    // `waiting` is WHY a row has not gone out, not a lane of its own — it
    // renders beside `queued`, with the hold reported separately.
    queued.push(row);
  }

  return { queued, failed, inFlightIds, held };
}
