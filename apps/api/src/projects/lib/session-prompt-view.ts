/**
 * The prompt inbox's WIRE VIEW: how one durable `session_lifecycle_commands`
 * row is presented to a client.
 *
 * Lives beside the routes rather than inside one because TWO readers serve it —
 * `GET .../prompts` and the session-open bundle — and a queue rendered from two
 * different projections of one row is a queue whose "Queued"/"Delivering" label
 * depends on which endpoint answered first.
 *
 * Pure. No database, no auth: the caller owns both.
 */

import { sessionLifecycleCommands } from '@kortix/db';
import { PROMPT_TEXT_PREVIEW_CHARS } from '../session-lifecycle/prompt-parts';

export type PromptRow = typeof sessionLifecycleCommands.$inferSelect;

/** One inbox row in wire shape — the element type of `{ prompts: [...] }`. */
export type SessionPromptView = ReturnType<typeof serializePrompt>;

/**
 * Map a durable command row onto the inbox's four user-visible states.
 *
 * `succeeded` no longer means "never appears". A FORWARDED row is `succeeded`
 * so the drain can never re-claim it, and still unanswered: OpenCode has
 * persisted the message and queued it behind the turn in flight. It reads
 * `delivering` until the `session_turns` ledger confirms a turn consumed it —
 * which is what keeps the composer working across that interval instead of
 * showing the user nothing. Only a `delivered` row disappears; it IS the
 * transcript by then.
 */
export function promptState(row: Pick<PromptRow, 'status' | 'result'>): {
  state: 'queued' | 'delivering' | 'waiting' | 'failed';
  reason: string | null;
} {
  const result = (row.result ?? {}) as Record<string, unknown>;
  // TERMINAL FIRST, above every marker on the row. A row can be given up on
  // while it still carries `forwarded` — `deadLetter` (redelivery.ts) is
  // exactly that — and reading the marker first made it `delivering` for ever:
  // the strip filters in-flight rows out, `countLiveInboxPrompts` counts them
  // as live work, and the sweep scans `succeeded` only. Nothing could close it.
  // `failed` is the state that carries the retry, which is the way out.
  if (row.status === 'failed' || row.status === 'dead_lettered') {
    return { state: 'failed', reason: null };
  }
  // Then HELD: a held row is waiting on the USER, not on the session — the stop
  // button put it there, and only an explicit send or "send now" takes it out.
  // It outranks the markers below: a held row is not in line at all, and that
  // is true of a forwarded row Stop paused just as much as of a queued one.
  if (result.held === true) return { state: 'waiting', reason: 'held' };
  // Then FORWARDED, above `running`: this is a `succeeded` row, so every branch
  // below would otherwise fall through to `queued` and show a prompt that is
  // already at OpenCode as if it had never been sent.
  if (result.status === 'forwarded') return { state: 'delivering', reason: 'forwarded' };
  if (row.status === 'running') return { state: 'delivering', reason: null };
  const admission = result.admission_reason;
  if (typeof admission === 'string') return { state: 'waiting', reason: admission };
  // Parked on a DOWN runtime. Still `queued` — the row IS in line and the server
  // re-attempts it (on a wake, or on its backoff ladder), so anything else would
  // be a lie in the direction that lost the message before: `failed` invited a
  // manual retry for work the server was already doing. The reason names WHAT it
  // is waiting for, and `runtime_retries` says how much patience is left.
  if (result.delivery_blocked === 'runtime_unreachable') {
    return { state: 'queued', reason: 'runtime_unreachable' };
  }
  return { state: 'queued', reason: null };
}

/**
 * What a queued prompt's attachments are, WITHOUT their bytes.
 *
 * A reload discards the composer's optimistic bubble, so this durable row is
 * the only thing left that knows a prompt had files. It carried `text` alone,
 * and a refreshed tab therefore rendered a bare sentence for a send of seven
 * attachments while the upload was still in flight (2026-09-04) — the user
 * could not tell a stuck upload from a prompt that never had files.
 *
 * Names and MIME types only. The parts hold `data:` URLs measured in megabytes
 * and this view is POLLED; shipping the bytes would re-send the whole payload
 * on every tick. A name and a type is all a pending tile draws.
 */
const PROMPT_ATTACHMENT_LIMIT = 32;

function promptAttachments(payload: Record<string, unknown>): Array<{
  filename: string;
  mime: string;
}> {
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const attachments: Array<{ filename: string; mime: string }> = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const file = part as { type?: unknown; filename?: unknown; mime?: unknown };
    if (file.type !== 'file') continue;
    attachments.push({
      filename: typeof file.filename === 'string' && file.filename.trim() ? file.filename : 'File',
      mime: typeof file.mime === 'string' ? file.mime : 'application/octet-stream',
    });
    if (attachments.length >= PROMPT_ATTACHMENT_LIMIT) break;
  }
  return attachments;
}

export function serializePrompt(row: PromptRow) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const result = (row.result ?? {}) as Record<string, unknown>;
  const { state, reason } = promptState(row);
  return {
    prompt_id: row.commandId,
    client_message_id: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : '',
    // The id the message ACTUALLY carries in the transcript, when known: the
    // drain re-mints a mid-turn prompt above the live turn's ids, and the strip
    // hides a row the moment the transcript shows its message — a client-minted
    // id here left the row on screen beside its own bubble until the next poll.
    message_id:
      typeof result.forwarded_message_id === 'string'
        ? result.forwarded_message_id
        : typeof payload.redeliveredMessageId === 'string'
          ? payload.redeliveredMessageId
          : typeof payload.wireMessageId === 'string'
            ? payload.wireMessageId
            : '',
    // The id the CLIENT painted its bubble under. `message_id` above moves to
    // the re-minted id the moment the drain places the prompt — before the
    // runtime echoes it — and a client that only knew `message_id` drew the
    // row beside its own bubble for that window (a second dimmed copy for
    // ~0.4 s on every mid-turn send). Both ids name one prompt.
    wire_message_id: typeof payload.wireMessageId === 'string' ? payload.wireMessageId : '',
    client_sent_at_ms:
      typeof payload.clientSentAtMs === 'number' ? payload.clientSentAtMs : null,
    state,
    reason,
    text: (typeof payload.text === 'string' ? payload.text : '').slice(
      0,
      PROMPT_TEXT_PREVIEW_CHARS,
    ),
    attempts: row.attempts,
    // How many automatic re-attempts a runtime-unreachable park has spent, out
    // of MAX_RUNTIME_UNREACHABLE_RETRIES. 0 for every other row.
    runtime_retries: typeof result.runtime_retries === 'number' ? result.runtime_retries : 0,
    last_error: row.lastError ?? null,
    /** Names + types of this prompt's files, so a reloaded tab can still draw
     *  their tiles while the send is in flight. Never the bytes. */
    attachments: promptAttachments(payload),
    created_at: row.createdAt.toISOString(),
    available_at: row.availableAt.toISOString(),
  };
}
