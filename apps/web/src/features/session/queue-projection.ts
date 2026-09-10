import type { SessionPrompt } from '@kortix/sdk';
import { isOptimisticSessionPrompt } from '@kortix/sdk/react';

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
  /** The queue is held by a stop or by a failed turn — see `holdSessionPrompts`. */
  held: boolean;
}

/**
 * IS THIS ROW ALREADY ON SCREEN AS A MESSAGE?
 *
 * The one rule, for every reader. It used to be written out twice, with two
 * different answers: this file matched all three ids, while
 * `queuedSyntheticMessages` in `session-chat.tsx` — the reader that actually
 * paints the bubbles — matched only `message_id` and `wire_message_id`. The
 * case the third clause exists for therefore still drew a duplicate.
 *
 * ANY of the prompt's ids counts, because a prompt has three and which ones
 * agree changes with time:
 *
 *  - `message_id` moves to the server's re-minted id the moment the drain
 *    places the prompt — before the runtime echoes it, and before the store can
 *    alias the echo back.
 *  - `wire_message_id` is the id THIS tab painted its bubble under, which the
 *    re-mint leaves behind.
 *  - `client_message_id` is the only one that survives BOTH a re-mint and a
 *    reload: the two wire ids can be re-minted out from under a stuck row, and
 *    a hard refresh drops the store's in-memory echo alias. It is what stops
 *    the "Queued" badge outliving a refresh with its reply already on screen.
 *
 * Effective only where the caller's id set carries the same ids — see
 * `transcriptClaimedIds`.
 */
export function promptIsOnScreen(
  prompt: Pick<SessionPrompt, 'message_id' | 'wire_message_id' | 'client_message_id'>,
  transcriptMessageIds?: ReadonlySet<string>,
): boolean {
  if (!transcriptMessageIds) return false;
  return (
    (!!prompt.message_id && transcriptMessageIds.has(prompt.message_id)) ||
    (!!prompt.wire_message_id && transcriptMessageIds.has(prompt.wire_message_id)) ||
    (!!prompt.client_message_id && transcriptMessageIds.has(prompt.client_message_id))
  );
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
    // HELD BY THE STOP BUTTON, not by the user parking this one row.
    //
    // Cmd/Ctrl+Enter parks a prompt by holding it server-side — the same
    // mechanism, because "not due until the user says" is what both mean. So a
    // parked row also arrives as `reason: 'held'`, and reading that field alone
    // lit the "Queue paused — Resume" banner and dimmed the whole list the
    // first time anyone parked a prompt on an idle session.
    //
    // `stop_held` is the server saying which hold this is, and it is why the
    // `queued_by_user` clause below is no longer the whole answer. That clause
    // alone made a Stop INVISIBLE on a queue of nothing but parked rows — the
    // feature's normal state: `paused` never lit, no Resume was offered, and
    // the header went on promising "runs after this turn". Both directions
    // matter, so both are tested: a parked row on its own is not a stop, and a
    // stop is a stop even when every row is parked.
    //
    // The second clause still stands for a server older than `stop_held`.
    if (prompt.stop_held === true) held = true;
    else if (prompt.reason === 'held' && !prompt.queued_by_user) held = true;
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
    // Which ids count, and why all three: `promptIsOnScreen`.
    if (promptIsOnScreen(prompt, input.transcriptMessageIds)) continue;
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

/**
 * HOW MANY PROMPTS AN ERROR HALT HAS TO PROTECT — every lane, not one.
 *
 * When a turn ends in failure the client holds the inbox, so the next prompt
 * cannot be answered by the same broken session. That gate used to count the
 * PARKED rows only (`queued_by_user`), which left the other lane unguarded: a
 * turn that errored with ordinary Enter-queued rows behind it held nothing, and
 * they drained straight into the failure at the next boundary. Nothing on the
 * server catches it either — `turnCompletionAllowsQueuePromotion` passes on
 * `closed`, and an errored turn is closed.
 *
 * Both lanes are the same durable rows. Only where the user watches them wait
 * differs, and that is not a reason to protect one of them and not the other.
 *
 * `failed` rows are excluded: a row that has given up is not going anywhere on
 * its own and carries its own retry. Deliberately NOT `countLiveInboxPrompts`,
 * which drops held rows — a parked row is exactly what the halt is protecting.
 */
export function countHaltableInboxPrompts(prompts: readonly SessionPrompt[]): number {
  let live = 0;
  for (const prompt of prompts) if (prompt.state !== 'failed') live += 1;
  return live;
}
