import type { QueuedDraft } from '@/stores/queued-draft-store';
import {
  sessionPromptActions,
  type SessionPrompt,
  type SessionPromptDelivery,
  type SessionPromptSteerFallback,
  type SessionPromptViewer,
} from '@kortix/sdk';
import { isOptimisticSessionPrompt } from '@kortix/sdk/react';
import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseSessionReferences,
  stripReplyContexts,
} from './message-parsing';

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
  /** The server can still remove this prompt, and this viewer may. */
  removable: boolean;
  /** Delivery gave up and this viewer may send it again (its author). */
  retryable: boolean;
  /** Another member sent it: it runs as them, so only they edit or send it. */
  fromAnotherMember?: true;
  /** The running turn reads this prompt at its next step (`delivery: 'steer'`). */
  steer?: true;
  /** Why a steer prompt waits for the turn to end instead. */
  steerFallback?: SessionPromptSteerFallback;
  /** "Stop and send" can turn it into Quick Queue: it is still waiting and
   *  not yet on the wire. */
  interruptible: boolean;
  /** Up (or the pencil) opens it in the composer for an in-place edit. */
  takeBackEligible: boolean;
  /** The prompt's whole text as the server holds it: quotes, file and
   *  mention markup included. */
  rawText: string;
  /** The words the composer edits — one verbatim run of `rawText`, so an edit
   *  swaps exactly them and every quote or reference around them survives.
   *  `null` when the visible words are not one run, so no edit is offered. */
  editText: string | null;
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
  /** Who is looking. A prompt runs as its author, so edit, Stop and send and
   *  retry are the author's only (`sessionPromptActions`). Omitted: every row
   *  reads as the viewer's own. */
  viewer?: SessionPromptViewer;
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
    const rawText = prompt.full_text ?? prompt.text;
    const cleaned = cleanPromptText(rawText);
    const editText = cleaned.text && rawText.includes(cleaned.text) ? cleaned.text : null;
    const state: QueueRowState =
      prompt.state === 'failed'
        ? 'failed'
        : prompt.state === 'delivering'
          ? 'delivering'
          : isOptimisticSessionPrompt(prompt)
            ? 'sending'
            : 'queued';
    const attachmentCount = draft
      ? draft.files.length
      : Math.max(prompt.attachments?.length ?? 0, cleaned.fileCount);
    // A server built before steering lists no `delivery`: its row is a queue row.
    const steer = prompt.delivery === 'steer';
    const { own, removable } = input.viewer
      ? sessionPromptActions(prompt, input.viewer)
      : { own: true, removable: true };

    rows.push({
      id: prompt.prompt_id,
      clientMessageId: prompt.client_message_id,
      text: draft?.text ?? cleaned.text,
      attachmentCount,
      state,
      ...(state === 'failed' && prompt.last_error ? { lastError: prompt.last_error } : {}),
      // A steered prompt on the wire is still unread: the server takes it back.
      removable:
        removable && (state === 'queued' || state === 'failed' || (steer && state === 'delivering')),
      retryable: own && state === 'failed',
      ...(own ? {} : { fromAnotherMember: true as const }),
      ...(steer ? { steer: true as const } : {}),
      ...(prompt.steer_fallback ? { steerFallback: prompt.steer_fallback } : {}),
      interruptible: own && state === 'queued',
      // The edit changes the text in place on the server; files stay on the row.
      takeBackEligible: own && state === 'queued' && editText !== null,
      rawText,
      editText,
    });
  }

  // Sends still uploading: the inbox has no row for them yet.
  for (const draft of input.drafts ?? []) {
    if (draft.placement === 'transcript' || draft.posted || listed.has(draft.clientMessageId))
      continue;
    rows.push({
      id: `draft:${draft.clientMessageId}`,
      clientMessageId: draft.clientMessageId,
      text: draft.text,
      attachmentCount: draft.files.length,
      state: 'sending',
      removable: false,
      retryable: false,
      ...(draft.delivery === 'steer' ? { steer: true as const } : {}),
      interruptible: false,
      takeBackEligible: false,
      rawText: draft.text,
      editText: null,
    });
  }

  return { rows, heldCount };
}

/**
 * How a composer send reaches the session (D9.1).
 *
 * - Enter while a turn runs: `steer`. The running turn reads it at its next
 *   step. It waits in the list above the composer until the transcript has it.
 * - Cmd/Ctrl+Enter (`composer`): `queue` (Queue List).
 * - Enter while idle: unchanged. It starts a turn and paints in the transcript.
 */
export function composerSendDelivery(
  placement: 'transcript' | 'composer',
  busy: boolean,
): { placement: 'transcript' | 'composer'; delivery?: SessionPromptDelivery } {
  if (placement === 'composer') return { placement, delivery: 'queue' };
  return busy ? { placement: 'composer', delivery: 'steer' } : { placement };
}
