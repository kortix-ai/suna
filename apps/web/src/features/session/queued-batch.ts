/**
 * Turning a claimed queue batch into the one prompt that carries it.
 *
 * The queue drains all at once: everything waiting when the turn ends goes out
 * together, in the order it was typed. This is the part that decides what
 * "together" looks like on the wire, and it is a pure function because the
 * alternative — a merge buried inside `session-chat.tsx`'s send path — is a
 * decision nobody can assert. The ordering, the separator, the attachments
 * that must not be lost and the mentions that must not be duplicated are all
 * things worth catching in a test rather than in a session.
 *
 * **One prompt, never a loop.** `handleSend` resolves when the server ACKs the
 * prompt (204), not when the turn ends, so a caller that sent the batch with N
 * calls would put messages 2..N inside message 1's live turn. That is RC4 in
 * `docs/superpowers/specs/2026-08-05-session-message-queue-design.md`, and it
 * is the bug that made the queue release one message per turn in the first
 * place. The fix for N racing turns is one turn carrying N messages.
 */

import type { AttachedFile, TrackedMention } from '@/features/session/composer/types';
import type { WebQueuedMessage } from '@/stores/message-queue-store';

/** Exactly the arguments `handleSend` takes, for one batch. */
export interface MergedQueuedBatch {
  text: string;
  /** Absent rather than empty — `handleSend` branches on presence. */
  files?: AttachedFile[];
  mentions?: TrackedMention[];
  overrides: {
    agent?: string | null;
    model?: { providerID: string; modelID: string } | null;
    variant?: string | null;
    /** The head entry's stable key. A retried entry drains as a batch of one,
     *  so re-sending its id makes the retry byte-identical on the wire and the
     *  proxy's body-hash dedupe absorbs a prompt the server already accepted. */
    clientMessageId?: string;
  };
}

/**
 * Merge a claimed batch into a single send. `null` when there is nothing to
 * send.
 *
 * The texts join with a blank line, which is what the user would have typed
 * had they written it as one message. No wrapper markup: the separator is for
 * the agent to read, and a `<queued_message>` tag would leak plumbing into
 * both the prompt and the bubble the user sees afterwards.
 *
 * `overrides` comes from the head because `claimBatch` only ever groups
 * messages that share the head's agent, model and variant — so every message
 * here still sends under the settings it was queued with.
 */
export function mergeQueuedBatch(batch: WebQueuedMessage[]): MergedQueuedBatch | null {
  const head = batch[0];
  if (!head) return null;

  // A `lost` attachment is what a file becomes after a reload: a marker with
  // no data. Send the text rather than a broken attachment — the composer
  // already shows the user that the file was dropped.
  const files = batch
    .flatMap((message) => message.files ?? [])
    .filter((file): file is AttachedFile => file.kind !== 'lost');

  // One `<file_ref />` / `<agent_ref />` block goes out per prompt, so the
  // same file mentioned in two queued messages must not be listed twice.
  const mentions: TrackedMention[] = [];
  const seen = new Set<string>();
  for (const mention of batch.flatMap((message) => message.mentions ?? [])) {
    const key = `${mention.kind}:${mention.value ?? mention.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(mention);
  }

  return {
    text: batch.map((message) => message.text).join('\n\n'),
    ...(files.length > 0 ? { files } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    // Spread verbatim, including `undefined`. `handleSend` reads `undefined` as
    // "resolve when this sends" and `null` as "send none at all"; coercing one
    // into the other strips the user's model from the send.
    overrides: {
      agent: head.agent,
      model: head.model,
      variant: head.variant,
      clientMessageId: head.clientMessageId,
    },
  };
}
