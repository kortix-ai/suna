import type { QueuedDraft } from '@/stores/queued-draft-store';
import type { RemovedSessionPrompt, SessionPrompt } from '@kortix/sdk';
import { isOptimisticSessionPrompt } from '@kortix/sdk/react';
import type { AttachedFile } from './composer/types';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseSessionReferences,
  stripReplyContexts,
} from './message-parsing';
import { isRetryableFailure } from './queue-failure-copy';

/**
 * What the queued list above the composer (`composer/queued-prompt-list.tsx`)
 * renders, from the ONE thing that holds a pending message.
 *
 * The server inbox (`GET .../prompts`) is the queue: durable, shared across
 * tabs and devices, ordered and admitted by the control plane. Composer entries
 * stay here until admitted. Transcript entries are drawn in the conversation.
 *
 * `drafts` are this tab's own queued sends (`queued-draft-store.ts`). They add
 * the text as typed, the original files, and a row for the upload window before
 * the inbox has one. They never add a row the inbox has already delivered.
 */

/**
 * Is this row the session's FIRST prompt? `startSessionWithPrompt` mints
 * `start_…`; the API's `create.pending_prompt` mints `pending:<session>`
 * (`apps/api/.../pending-prompt.ts`). That prompt is the turn about to run, and
 * the transcript draws it (`OptimisticTurn`, synthetic turns) — never the list.
 */
export function isFirstPromptRow(prompt: Pick<SessionPrompt, 'client_message_id'>): boolean {
  const id = prompt.client_message_id ?? '';
  return id.startsWith('start_') || id.startsWith('pending:');
}

/**
 * - `sending`: this tab's send, not yet confirmed by the server. No server id,
 *   so nothing can be done to it yet.
 * - `queued`: waiting for its turn (held rows included — see `heldCount`).
 * - `delivering`: handed to the runtime; its turn is starting. The server
 *   refuses removal.
 * - `failed`: delivery gave up; retry or remove.
 */
export type QueueRowState = 'sending' | 'queued' | 'delivering' | 'failed';

export interface QueueRow {
  /** The inbox `prompt_id`, or `draft:<clientMessageId>` before the POST. */
  id: string;
  clientMessageId: string;
  text: string;
  attachmentCount: number;
  state: QueueRowState;
  lastError?: string;
  /** Why delivery gave up, as a stable code (`queue-failure-copy.ts` turns it
   *  into a sentence). Absent for a failure nothing named. */
  failureCode?: string;
  /** Sending this again can help — false for a session that no longer exists,
   *  and for every row that has not failed. */
  retryable: boolean;
  /** The server can still remove this prompt. */
  removable: boolean;
  /** The composer can edit it in place without losing anything: its text is
   *  all there is, or this tab still holds its files. */
  takeBackEligible: boolean;
  /** Send now can still move it ahead: the server holds it in line. */
  canSendNow: boolean;
  /** This row already has a request in flight (`promptInbox.pendingActions`).
   *  It must not accept a second one — see `acceptRowAction`. */
  pendingAction?: 'retry' | 'remove';
}

export interface QueueProjection {
  /** In delivery order: the server's rows first, then this tab's unsent drafts. */
  rows: QueueRow[];
  /** Rows the Stop hold is pausing — counted even when the row is on screen in
   *  the transcript, so Resume is reachable whenever the server holds anything. */
  heldCount: number;
}

/** A prompt's visible words: the transport blocks the send path appends
 *  (reply context, upload refs, mention refs) stripped back out. */
export function cleanPromptText(text: string): { text: string; fileCount: number } {
  const withoutReply = stripReplyContexts(text);
  const uploads = parseFileReferences(withoutReply);
  const withoutSessions = parseSessionReferences(uploads.cleanText).cleanText;
  const withoutFiles = parseFileMentionReferences(withoutSessions).cleanText;
  const withoutAgents = parseAgentMentionReferences(withoutFiles).cleanText;
  return { text: withoutAgents.trim(), fileCount: uploads.files.length };
}

/** Where a server row stands — see `QueueRowState`. */
export function queueRowStateOf(prompt: Pick<SessionPrompt, 'prompt_id' | 'state'>): QueueRowState {
  return prompt.state === 'failed'
    ? 'failed'
    : prompt.state === 'delivering'
      ? 'delivering'
      : isOptimisticSessionPrompt(prompt)
        ? 'sending'
        : 'queued';
}

/**
 * The server can still remove this prompt. ONE rule for both lanes: the Queue
 * List row and the waiting Quick Queue bubble offer Remove for exactly the same
 * rows, and neither guesses whether a prompt already handed to the runtime can
 * still be cancelled.
 */
export function promptRowRemovable(prompt: Pick<SessionPrompt, 'prompt_id' | 'state'>): boolean {
  const state = queueRowStateOf(prompt);
  return state === 'queued' || state === 'failed';
}

/** The Remove a waiting Quick Queue bubble offers. */
export interface QuickQueueRemove {
  promptId: string;
  /** This row already has a request in flight: the control stays, and refuses
   *  a press — the same rule as `QueueRow.pendingAction`. */
  pendingAction?: 'retry' | 'remove';
}

/**
 * What a Quick Queue bubble in the conversation offers while it waits, or
 * `null` for nothing.
 *
 * Offered exactly while the inbox lists the row and the server can remove it.
 * A FAILED prompt is left out on purpose: its failure line already carries
 * Retry and Remove (`QueuedPromptFailure`), and a bubble has one Remove. The
 * session's first prompt is the turn about to run, not a queue entry.
 */
export function quickQueueRemove(input: {
  /** The bubble's inbox row. Absent once the inbox stops listing it. */
  prompt: SessionPrompt | undefined;
  /** The host knows this turn is the first prompt by more than the row's own
   *  id — a re-mint claim can name it (`SessionChat`). */
  firstPrompt?: boolean;
  /** `promptInbox.pendingActions[prompt.prompt_id]`. */
  pendingAction?: 'retry' | 'remove';
}): QuickQueueRemove | null {
  const { prompt } = input;
  if (!prompt || input.firstPrompt || isFirstPromptRow(prompt)) return null;
  if (prompt.state === 'failed' || !promptRowRemovable(prompt)) return null;
  return {
    promptId: prompt.prompt_id,
    ...(input.pendingAction ? { pendingAction: input.pendingAction } : {}),
  };
}

/**
 * Every transcript id this tab may have painted `promptId`'s bubble under, for
 * a Remove that is about to be sent.
 *
 * `promptInbox.remove` takes the row out of `prompts` on the click. A bubble
 * this tab painted optimistically would outlive it for the DELETE round trip,
 * and with no row it reads as an ordinary message. So the host takes the
 * bubble down in the same frame. Nothing is lost if the server refuses: the
 * next inbox read lists the row again and the conversation redraws the bubble
 * from it. Until that read lands the bubble is absent while the error toast
 * says the prompt stayed. The bubble is NOT put back by hand on a refusal: a
 * DELETE that timed out may have succeeded, and a re-inserted optimistic
 * message with no row behind it would never leave.
 *
 * Empty for a row with an action in flight — the SDK sends no DELETE for it.
 */
export function paintedMessageIdsOf(
  inbox: {
    prompts: readonly Pick<SessionPrompt, 'prompt_id' | 'message_id' | 'wire_message_id'>[];
    pendingActions: Readonly<Record<string, 'retry' | 'remove'>>;
  },
  promptId: string,
): string[] {
  if (inbox.pendingActions[promptId]) return [];
  const row = inbox.prompts.find((prompt) => prompt.prompt_id === promptId);
  if (!row) return [];
  return [...new Set([row.message_id, row.wire_message_id])].filter((id): id is string =>
    Boolean(id),
  );
}

function onScreen(prompt: SessionPrompt, transcriptIds: ReadonlySet<string> | undefined): boolean {
  if (!transcriptIds) return false;
  // ANY of the prompt's ids counts. `message_id` moves to the server's
  // re-minted id when the drain places the prompt; `wire_message_id` is the id
  // this tab painted; `client_message_id` is the only one that survives both a
  // re-mint and a reload.
  return Boolean(
    (prompt.message_id && transcriptIds.has(prompt.message_id)) ||
    (prompt.wire_message_id && transcriptIds.has(prompt.wire_message_id)) ||
    (prompt.client_message_id && transcriptIds.has(prompt.client_message_id)),
  );
}

export function projectQueueRows(input: {
  prompts: readonly SessionPrompt[];
  /** Every message id the transcript is showing. Optional for callers with no
   *  transcript (tests). */
  transcriptMessageIds?: ReadonlySet<string>;
  drafts?: readonly QueuedDraft[];
  /** The row actions in flight, by `prompt_id` (`promptInbox.pendingActions`).
   *  A draft has no server row, so no entry can reach it. */
  pendingActions?: Readonly<Record<string, 'retry' | 'remove'>>;
  /** Sends that failed before the server had a row, by WIRE message id
   *  (`useHeldSendFailureStore`). That store is the one source of failure
   *  truth for a send: the transcript reads it for a Quick Queue bubble, and
   *  this reads the same entry for a Queue List row. A draft names its own key
   *  (`QueuedDraft.messageId`), so this stays a pure read. */
  heldSendFailures?: Readonly<Record<string, { message: string; code?: string }>>;
}): QueueProjection {
  const draftsById = new Map((input.drafts ?? []).map((d) => [d.clientMessageId, d] as const));
  const rows: QueueRow[] = [];
  const listed = new Set<string>();
  let heldCount = 0;

  for (const prompt of input.prompts) {
    if (prompt.client_message_id) listed.add(prompt.client_message_id);
    if (prompt.reason === 'held' && prompt.state !== 'failed') heldCount += 1;
    if (isFirstPromptRow(prompt) || prompt.placement === 'transcript') continue;
    if (onScreen(prompt, input.transcriptMessageIds)) continue;

    const draft = prompt.client_message_id ? draftsById.get(prompt.client_message_id) : undefined;
    const cleaned = cleanPromptText(prompt.full_text ?? prompt.text);
    const state = queueRowStateOf(prompt);
    const attachmentCount = draft
      ? draft.files.length
      : Math.max(prompt.attachments?.length ?? 0, cleaned.fileCount);

    const failureCode = state === 'failed' ? (prompt.failure_code ?? null) : null;

    rows.push({
      id: prompt.prompt_id,
      clientMessageId: prompt.client_message_id,
      text: draft?.text ?? cleaned.text,
      attachmentCount,
      state,
      ...(state === 'failed' && prompt.last_error ? { lastError: prompt.last_error } : {}),
      ...(failureCode ? { failureCode } : {}),
      retryable: state === 'failed' && isRetryableFailure(failureCode),
      removable: promptRowRemovable(prompt),
      // A row from another tab or from before a reload comes back only when
      // its text is all there is: its files live as sandbox paths the composer
      // cannot re-attach.
      takeBackEligible:
        state === 'queued' && (Boolean(draft) || attachmentCount === 0),
      canSendNow: state === 'queued',
      ...(input.pendingActions?.[prompt.prompt_id]
        ? { pendingAction: input.pendingActions[prompt.prompt_id] }
        : {}),
    });
  }

  // Sends still uploading: the inbox has no row for them yet.
  for (const draft of input.drafts ?? []) {
    if (draft.placement === 'transcript' || draft.posted || listed.has(draft.clientMessageId))
      continue;
    // The wire id `handleSend` minted for this draft, carried ON the draft —
    // never re-derived here. `mintSessionWireMessageId` memoizes in a module
    // Map capped at 256 pairs and evicts the oldest, so re-deriving would mint
    // a NEW id once a long-lived tab passed the cap, miss the failure, and
    // strand the row as `sending` with no Retry and no Remove. It would also
    // make this projection write to that Map during render.
    const failure = draft.messageId ? input.heldSendFailures?.[draft.messageId] : undefined;
    rows.push({
      id: draftRowId(draft.clientMessageId),
      clientMessageId: draft.clientMessageId,
      text: draft.text,
      attachmentCount: draft.files.length,
      // A send that failed before the POST leaves nothing durable behind. The
      // row is this tab's only copy of the message, so it has to say what went
      // wrong and offer both ways out.
      state: failure ? 'failed' : 'sending',
      ...(failure ? { lastError: failure.message } : {}),
      ...(failure?.code ? { failureCode: failure.code } : {}),
      retryable: Boolean(failure) && isRetryableFailure(failure?.code),
      removable: Boolean(failure),
      takeBackEligible: false,
      canSendNow: false,
    });
  }

  return { rows, heldCount };
}

/** A queued row with no server row yet: `draft:<clientMessageId>`. */
const DRAFT_ROW_PREFIX = 'draft:';

function draftRowId(clientMessageId: string): string {
  return `${DRAFT_ROW_PREFIX}${clientMessageId}`;
}

/** Is this row this tab's own draft rather than an inbox row? */
export function isDraftRowId(rowId: string): boolean {
  return rowId.startsWith(DRAFT_ROW_PREFIX);
}

/** The submission this draft row stands for, or `null` for a server row. */
export function draftClientMessageId(rowId: string): string | null {
  return isDraftRowId(rowId) ? rowId.slice(DRAFT_ROW_PREFIX.length) : null;
}

/**
 * The wire id one draft's send was minted under, or `null`.
 *
 * The two draft row actions need the key the held-send store holds the failure
 * by, and it has to be the SAME key this projection read — so both take it off
 * the draft rather than minting it a second time.
 */
export function draftMessageId(
  drafts: readonly QueuedDraft[],
  clientMessageId: string,
): string | null {
  return drafts.find((d) => d.clientMessageId === clientMessageId)?.messageId ?? null;
}

/**
 * The `prompt_id` of the row a submission created, or `null`.
 *
 * A DELETE matches `prompt_id`, never the wire message id. A send whose
 * response was lost holds only its `client_message_id`, so the row it may have
 * created is found by that and removed by the id the route accepts.
 */
export function promptIdForClientMessage(
  prompts: readonly SessionPrompt[],
  clientMessageId: string,
): string | null {
  return prompts.find((p) => p.client_message_id === clientMessageId)?.prompt_id ?? null;
}

/**
 * Which queued prompts an edit-send's rewind has to DELETE.
 *
 * A rewind stages `session.revert` and the NEXT delivered prompt commits it, so
 * every row queued before the rewind would commit the truncation and then run
 * against a trajectory that no longer exists. They all go.
 *
 * Two are left alone, and neither is a preference:
 *
 * - A row whose own remove or retry is already on the wire (`pendingActions`).
 *   The SDK returns that in-flight result for a duplicate, so a second DELETE
 *   buys nothing and its refusal is swallowed by the loop's `console.warn`.
 * - A row already handed to the runtime (`state === 'delivering'`). The server
 *   refuses to remove it.
 *
 * A row the user removed during the rewind await is not here at all: the caller
 * passes the LIVE inbox, and the SDK filters a removed row out of its cache on
 * the click.
 */
export function rowsToRemoveOnRewind(input: {
  prompts: readonly SessionPrompt[];
  pendingActions?: Readonly<Record<string, 'retry' | 'remove'>>;
}): SessionPrompt[] {
  return input.prompts.filter(
    (prompt) => prompt.state !== 'delivering' && !input.pendingActions?.[prompt.prompt_id],
  );
}

