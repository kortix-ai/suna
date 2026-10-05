import type { SessionPrompt } from '@kortix/sdk';
import { isOptimisticSessionPrompt } from '@kortix/sdk/react';

/**
 * WHICH inbox row a transcript message belongs to, when no id says so.
 *
 * Every other place that answers "is this row already on screen" matches ids —
 * `message_id`, `wire_message_id`, `client_message_id` — and that is right, up
 * to the one moment the ids disagree.
 *
 * The drain RE-MINTS a prompt's wire id when it delivers it, and persists the
 * new id before it POSTs (`remintWireMessageId`). The server therefore answers
 * the new id immediately; this tab does not, because its last `GET .../prompts`
 * body was fetched before the re-mint. So between the runtime's echo and the
 * next poll the transcript holds the message under the NEW id while the cached
 * row still names the OLD one, and nothing connects them:
 *
 *   - the id clauses miss, so the row mints a synthetic turn of its own;
 *   - `optimisticOriginOf` is empty, because a prompt typed on the project
 *     home is a server-created row and this tab never painted an optimistic
 *     message for it;
 *   - `registerOptimisticEcho` cannot help either: it is driven BY the row
 *     reporting two different ids, which is exactly the fact that has not
 *     arrived yet.
 *
 * The user sees their prompt twice, ~20s after sending it (the box boot), until
 * the next poll — reported 2026-09-08: "after some time user prompt get
 * duplicate, then no duplicate, then starting properly".
 *
 * So this claims by ELIMINATION rather than by id, and only where elimination
 * is a proof rather than a guess: one user message, unclaimed by any row, and a
 * row that provably went out. Every refusal below is a case where the message
 * could belong to something else.
 */
export interface FirstTurnClaim {
  /** The row that owns the message. */
  promptId: string;
  /** The transcript id it is on screen under (the re-minted one). */
  messageId: string;
  /** The ids the row still reports, which the caller folds into the
   *  "already on screen" set so every id-matching consumer agrees. */
  rowMessageId: string;
  rowWireMessageId?: string;
  rowClientMessageId?: string;
}

export function claimFirstTurnRow(input: {
  /** `GET .../prompts` order — the inbox is delivered FIFO. */
  prompts: readonly SessionPrompt[];
  /**
   * The transcript's ONLY user message — and only when it is not this tab's
   * own optimistic paint. Null otherwise. `text` is its visible text: the
   * non-synthetic text parts, joined.
   *
   * One message, because with two the mapping is a guess: two rows and two
   * messages can pair either way round, and pairing them wrongly attaches the
   * X and the "Queued" label to the wrong bubble. The reported bug is the
   * first prompt of a session, where there is exactly one.
   */
  onlyUserMessage: { id: string; text: string } | null;
  /** `transcriptUserMessageIds` as built from ids alone. */
  claimedIds: ReadonlySet<string>;
}): FirstTurnClaim | null {
  const message = input.onlyUserMessage;
  if (!message) return null;
  // A row already owns it by id — the ordinary path, nothing to infer.
  if (input.claimedIds.has(message.id)) return null;

  // THE WORDS are what the two copies always share. Nothing else on the row can
  // be trusted for this decision: the row on this tab may be a snapshot taken
  // before the drain touched it (the session-open bundle is served for seconds
  // after it lands), still reading `queued` and `attempts: 0` while the
  // runtime has already echoed the prompt. A guard on those fields refused the
  // claim on exactly the data it existed to correct (measured 2026-09-08).
  //
  // What the words protect against: a second device queues a NEW prompt while
  // this tab shows the previous turn's message. Different words, no claim, and
  // that queued bubble stays where the user can see it.
  //
  // First match wins — the inbox is FIFO, so of two rows with the same words
  // the older is the one that went out.
  const row = input.prompts.find(
    (prompt) =>
      !isOptimisticSessionPrompt(prompt) &&
      prompt.state !== 'failed' &&
      // HELD is the user's own Stop: deliberately not going out, so the message
      // on screen cannot be it, and its bubble is the only control the user
      // has to release it.
      prompt.reason !== 'held' &&
      promptTextMatches(prompt.text, message.text),
  );
  if (!row) return null;
  // Already hidden by one of its own ids; the caller has nothing to add.
  if (
    (row.message_id && input.claimedIds.has(row.message_id)) ||
    (row.wire_message_id && input.claimedIds.has(row.wire_message_id))
  ) {
    return null;
  }

  return {
    promptId: row.prompt_id,
    messageId: message.id,
    rowMessageId: row.message_id,
    ...(row.wire_message_id ? { rowWireMessageId: row.wire_message_id } : {}),
    ...(row.client_message_id ? { rowClientMessageId: row.client_message_id } : {}),
  };
}

/** The row carries a PREVIEW of the text (`PROMPT_TEXT_PREVIEW_CHARS`, 2000),
 *  so a longer message matches on its prefix. Whitespace is normalised on both
 *  sides: the row's text is the flattened parts, the message's is the joined
 *  parts, and neither owes the other its exact spacing. */
const PROMPT_TEXT_PREVIEW_CHARS = 2000;

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function promptTextMatches(rowText: string, messageText: string): boolean {
  const row = normalise(rowText);
  if (!row) return false;
  const message = normalise(messageText);
  if (row === message) return true;
  // A preview-capped row: compare what it could carry.
  return rowText.length >= PROMPT_TEXT_PREVIEW_CHARS - 1 && message.startsWith(row);
}
