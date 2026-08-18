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
  /** Pending rows, in delivery order. */
  queued: QueueRow[];
  /** Rows that gave up and offer a retry. */
  failed: QueueRow[];
  /** Rows already on the wire: not editable, not removable. */
  inFlightIds: string[];
  /** The queue is held by a stop — see `holdSessionPrompts`. */
  held: boolean;
}

export function projectQueueRows(input: { prompts: SessionPrompt[] }): QueueProjection {
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
    if (prompt.state === 'failed') failed.push(row);
    else if (prompt.state === 'delivering') inFlightIds.push(prompt.prompt_id);
    // `waiting` is WHY a row has not gone out, not a lane of its own — it
    // renders beside `queued`, with the hold reported separately.
    else queued.push(row);
  }

  return { queued, failed, inFlightIds, held };
}
