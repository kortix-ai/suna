import type { SessionPrompt, SessionPromptPart } from '@kortix/sdk';

import { promptIdForClientMessage } from './queue-projection';

/**
 * A painted send's POST, with the hand-off to the server's row.
 *
 * The local copy is what draws a send before the inbox lists it. It has to go
 * the moment the POST is accepted, exactly as it does when the sender awaits
 * its own POST. Kept, it outlives the send — hidden only while the inbox still
 * lists the row, so a Remove un-hides it and redraws a bubble the "Removed
 * from queue" toast says is gone. A refused POST keeps it: its Retry has
 * nothing else to act on.
 */
export function postThenDropLocalCopy(
  post: (parts: SessionPromptPart[]) => Promise<unknown>,
  dropLocalCopy: () => void,
): (parts: SessionPromptPart[]) => Promise<unknown> {
  return async (parts) => {
    const accepted = await post(parts);
    dropLocalCopy();
    return accepted;
  };
}

/** Everything the removal touches, passed in so the order can be asserted. */
export interface QueuedDraftRemoval {
  sessionId: string;
  /** The inbox idempotency key — the only name the server knows this send by. */
  clientMessageId: string;
  /** The WIRE id the send went out under: the held-send store's key. */
  messageId: string;
  failures: {
    failuresBySession: Readonly<
      Record<string, Readonly<Record<string, { send: { attachments?: { release?: () => void } } }>>>
    >;
    clearHeldSendFailure: (sessionId: string, messageId: string) => void;
  };
  drafts: { remove: (sessionId: string, clientMessageIds: readonly string[]) => void };
  /** Says "Removed from queue", once the row has actually left the list. */
  announceRemoved: () => void;
  /** The inbox this tab already holds. */
  listedPrompts: () => readonly SessionPrompt[];
  /** A fresh server read, for a POST whose response was lost before the inbox
   *  ever listed the row. `null` when there is no project route to read. */
  fetchPrompts: (() => Promise<readonly SessionPrompt[]>) | null;
  removePrompt: (promptId: string) => Promise<unknown>;
}

/**
 * Remove a Queue List send that failed before the server had a row.
 *
 * Order is the contract. The local copies go FIRST — the uploads the send was
 * holding, the kept failure, and the draft that draws the row — so the row
 * leaves the list on the click rather than after a round trip that may never
 * answer. Only then, best effort, does it hunt for the row a POST whose
 * response was lost may have created.
 *
 * That hunt resolves a `prompt_id`, never the wire id: the DELETE route matches
 * `prompt_id`, and a send that never saw a response knows only its own
 * `client_message_id`. No row and a 404 mean the same thing, so neither is
 * reported — the message is gone from this tab either way.
 */
export async function removeQueuedDraftSend(input: QueuedDraftRemoval): Promise<void> {
  input.failures.failuresBySession[input.sessionId]?.[
    input.messageId
  ]?.send.attachments?.release?.();
  input.failures.clearHeldSendFailure(input.sessionId, input.messageId);
  input.drafts.remove(input.sessionId, [input.clientMessageId]);
  // The same sentence a server-row Remove paints. It carries no Undo: nothing
  // durable was destroyed to restore from.
  input.announceRemoved();
  try {
    const promptId =
      promptIdForClientMessage(input.listedPrompts(), input.clientMessageId) ??
      (input.fetchPrompts
        ? promptIdForClientMessage(await input.fetchPrompts(), input.clientMessageId)
        : null);
    if (promptId) await input.removePrompt(promptId);
  } catch {
    // Best effort. This tab's copy of the message is gone either way.
  }
}
