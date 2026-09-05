import { isOptimisticSessionPrompt } from '@kortix/sdk/react';
import type { SessionPrompt } from '@kortix/sdk';

/**
 * What the transcript's queued bubbles (`turn/queued-prompt-bubbles.tsx`)
 * render, from the ONE thing that holds a pending message.
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
  /** The row's files, by name and type only — see `projectQueueRows`. */
  attachments?: ReadonlyArray<{ filename: string; mime: string }>;
  /** `uploading` while the row is undelivered, `failed` with the row's error. */
  uploadStatus?: { state: 'uploading' } | { state: 'failed'; message: string };
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
    const attachments = prompt.attachments ?? [];
    const row: QueueRow = {
      id: prompt.prompt_id,
      text: prompt.text,
      ...(prompt.last_error ? { lastError: prompt.last_error } : {}),
      // The row's files, by name — the only thing a bubble can draw for bytes
      // that are still travelling to the box. On a WARM box the transcript
      // component mounts within seconds and this list is what stands in for
      // the message until the runtime echoes it; drawn text-only, a send of
      // three files read as a send of none (2026-09-04, browser-measured).
      ...(attachments.length > 0
        ? {
            attachments,
            // `state`, never `last_error` alone — a queued row can carry a
            // stale error from an attempt the server is about to retry.
            uploadStatus:
              prompt.state === 'failed'
                ? ({ state: 'failed', message: prompt.last_error ?? 'Upload failed' } as const)
                : ({ state: 'uploading' } as const),
          }
        : {}),
    };
    if (prompt.reason === 'held') held = true;
    if (prompt.state === 'failed') {
      failed.push(row);
      continue;
    }
    // ALREADY ON SCREEN AS A MESSAGE. Every prompt this tab sends is painted
    // into the transcript on Enter under its wire id (and the store aliases a
    // re-minted echo back to it), and a foreign row lands there when the
    // runtime echoes it. The transcript wins; this list is for what is NOT in
    // it yet. A HELD row in the transcript is no exception any more: its
    // controls live in the bubble's own meta row (`QueuedPromptControls`).
    // ANY of the prompt's ids counts: `message_id` moves to the server's
    // re-minted id the moment the drain places the prompt — before the
    // runtime echoes it and before the store can alias the echo back — while
    // the bubble this tab painted still carries `wire_message_id`. Matching
    // only `message_id` drew the row beside its own bubble for that window.
    //
    // `client_message_id` is the THIRD, and it is the only one that survives
    // BOTH a re-mint and a reload: the two wire ids can be re-minted out from
    // under a stuck row, and a hard refresh drops the store's in-memory
    // `message_id`->bubble alias. When a wire-id divergence leaves the answer
    // on screen under an id the row no longer reports, the stable client id is
    // what still hides the row — so the "Queued" badge cannot survive a
    // refresh with its reply already visible. Effective only where the
    // transcript id set carries the client id.
    if (
      (prompt.message_id && input.transcriptMessageIds?.has(prompt.message_id)) ||
      (prompt.wire_message_id && input.transcriptMessageIds?.has(prompt.wire_message_id)) ||
      (prompt.client_message_id && input.transcriptMessageIds?.has(prompt.client_message_id))
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
    // This tab's own echo, painted on Enter before `POST .../prompts` returned:
    // there is no server id to remove or promote yet, so it renders inert for
    // the round-trip and becomes an ordinary row on the response.
    if (isOptimisticSessionPrompt(prompt)) inFlightIds.push(prompt.prompt_id);
    // `waiting` is WHY a row has not gone out, not a lane of its own — it
    // renders beside `queued`, with the hold reported separately.
    queued.push(row);
  }

  return { queued, failed, inFlightIds, held };
}
