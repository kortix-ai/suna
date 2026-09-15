import type { MessageWithParts } from '@/ui';
import { promptFileReferenceXml } from '@kortix/shared';
import type { SessionPrompt } from '@kortix/sdk';
import { isOptimisticSessionPrompt } from '@kortix/sdk/react';

import type { SentAttachment } from './sent-attachment-previews';
import type { AttachmentUploadStatus } from './turn/user-message';

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
  /** Present only when the accepted row failed before runtime delivery. */
  uploadStatus?: { state: 'failed'; message?: string };
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
            // The browser upload completed before this row was accepted. A
            // missing runtime path affects preview availability, not upload
            // progress. Keep only a real failed-send status here.
            ...(prompt.state === 'failed'
              ? {
                  uploadStatus: {
                    state: 'failed',
                    ...(prompt.last_error ? { message: prompt.last_error } : {}),
                  } as const,
                }
              : {}),
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

/** A send the boot shell painted on Enter, before any durable row lists it. */
export interface ShellExtraSend {
  id: string;
  text: string;
  attachments: ReadonlyArray<SentAttachment>;
  /** Its uploads or POST failed: the bubble stays, with Retry. */
  uploadStatus?: AttachmentUploadStatus;
}

/**
 * The boot shell's queue behind the first prompt: every durable row after the
 * first, plus the sends this shell made that no row lists yet (matched by text,
 * which is all the list view carries).
 *
 * A row that lists a shell send keeps that send's id (the bubble key) and its
 * attachment ids by index (the tile keys). The row's attachments carry only
 * `filename`/`mime`, so without this the bubble remounted and lost its picture.
 */
export function projectQueuedBehindFirst(
  prompts: ReadonlyArray<Pick<SessionPrompt, 'prompt_id' | 'text' | 'attachments'>>,
  extraSends: ReadonlyArray<ShellExtraSend>,
): ShellExtraSend[] {
  // The same rule `queuedPromptMessages` uses: an attachment-only prompt is a real message.
  const rows = prompts.filter((p) => p.text.trim().length > 0 || (p.attachments?.length ?? 0) > 0);
  const unclaimed = [...extraSends];
  const behind: ShellExtraSend[] = rows.slice(1).map((p) => {
    const files = p.attachments ?? [];
    const index = unclaimed.findIndex((extra) => extra.text.trim() === p.text.trim());
    if (index < 0) return { id: p.prompt_id, text: p.text, attachments: files };
    const [extra] = unclaimed.splice(index, 1);
    return {
      id: extra.id,
      text: p.text,
      attachments: files.map((file, i) => {
        const id = extra.attachments[i]?.id;
        return id ? { ...file, id } : file;
      }),
    };
  });
  const listed = new Set(rows.map((p) => p.text.trim()));
  for (const extra of extraSends) {
    if (!listed.has(extra.text.trim())) behind.push(extra);
  }
  return behind;
}

/**
 * Queue rows the transcript does not hold yet, as SYNTHETIC user messages for
 * the one turn list, so a queued prompt never renders below newer turns.
 *
 * A row's clock is the SENDER TAB's, and the box stamps real messages from its
 * own: a box ~1 s ahead sorted a fresh row ABOVE the previous turn (measured).
 * Every synthetic time is floored just past the newest real stamp, keeping the
 * rows' own order. The echo arrives under the same `message_id`, so the
 * synthetic turn becomes the real one in place.
 *
 * A row's files ride in its text as path-less `<file>` refs, the form a sent
 * message draws: a reloaded tab draws one named tile per file.
 */
export function queuedPromptMessages(input: {
  sessionId: string;
  messages: ReadonlyArray<{ info: unknown }> | undefined;
  prompts: readonly SessionPrompt[];
  claimedIds: ReadonlySet<string>;
}): MessageWithParts[] {
  let floor = 0;
  for (const message of input.messages ?? []) {
    const created = (message.info as { time?: { created?: number } }).time?.created;
    if (typeof created === 'number' && created > floor) floor = created;
  }
  const out: MessageWithParts[] = [];
  let previous = floor;
  for (const prompt of input.prompts) {
    if (prompt.state === 'failed') continue;
    const files = prompt.attachments ?? [];
    if (!prompt.text.trim() && files.length === 0) continue;
    if (prompt.message_id && input.claimedIds.has(prompt.message_id)) continue;
    if (prompt.wire_message_id && input.claimedIds.has(prompt.wire_message_id)) continue;
    if (isOptimisticSessionPrompt(prompt)) continue; // painted by this tab already
    const id = prompt.message_id || `queued-${prompt.prompt_id}`;
    const sentAt =
      typeof prompt.client_sent_at_ms === 'number'
        ? prompt.client_sent_at_ms
        : Date.parse(prompt.created_at);
    const createdMs = Math.max(sentAt, previous + 1);
    previous = createdMs;
    const refs = files
      .map((file) => promptFileReferenceXml({ path: '', mime: file.mime, filename: file.filename }))
      .join('\n');
    out.push({
      info: {
        id,
        sessionID: input.sessionId,
        role: 'user',
        time: Number.isFinite(createdMs) ? { created: createdMs } : {},
      },
      parts: [
        {
          id: `syn-${prompt.prompt_id}`,
          messageID: id,
          sessionID: input.sessionId,
          type: 'text',
          text: [prompt.text, refs].filter(Boolean).join('\n\n'),
        },
      ],
    } as unknown as MessageWithParts);
  }
  return out;
}
