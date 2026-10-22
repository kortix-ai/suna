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

import {
  type SessionPrompt,
  type SessionPromptDelivery,
  SessionPromptDeliverySchema,
  SessionPromptSteerFallbackSchema,
} from '@kortix/api-contract';
import { sessionLifecycleCommands } from '@kortix/db';
import { DELIVERY_FAILURE_COPY } from '../session-lifecycle/types';
import { PROMPT_TEXT_PREVIEW_CHARS } from '../session-lifecycle/prompt-parts';

export type PromptRow = typeof sessionLifecycleCommands.$inferSelect;

export { promptState } from './session-prompt-state';
import { promptState } from './session-prompt-state';

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

/**
 * The row's delivery mode. A row from before steering has none: `transcript`
 * is `interrupt` (Quick Queue), everything else `queue`.
 */
export function promptDelivery(payload: Record<string, unknown>): SessionPromptDelivery {
  const parsed = SessionPromptDeliverySchema.safeParse(payload.delivery);
  if (parsed.success) return parsed.data;
  return payload.placement === 'transcript' ? 'interrupt' : 'queue';
}

export function serializePrompt(row: PromptRow): SessionPrompt {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const result = (row.result ?? {}) as Record<string, unknown>;
  const { state, reason } = promptState(row);
  const steerFallback = SessionPromptSteerFallbackSchema.safeParse(payload.steerFallback);
  return {
    placement: payload.placement === 'transcript' ? 'transcript' as const : 'composer' as const,
    delivery: promptDelivery(payload),
    steer_fallback: steerFallback.success ? steerFallback.data : null,
    full_text: typeof payload.text === 'string' ? payload.text : '',
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
    last_error: readableDeliveryError(row.lastError),
    /** Names + types of this prompt's files, so a reloaded tab can still draw
     *  their tiles while the send is in flight. Never the bytes. */
    attachments: promptAttachments(payload),
    /** Posted without a turn (the first message of a conversation with people):
     *  no agent will answer it, so a host shows no "thinking" for it. */
    no_reply: payload.noReply === true,
    /** The member it runs as: only they edit, send now or retry it. */
    author_user_id: row.actorUserId ?? null,
    created_at: row.createdAt.toISOString(),
    available_at: row.availableAt.toISOString(),
  };
}

/** Older durable rows retain internal outcome labels across deployments. */
function readableDeliveryError(error: string | null): string | null {
  const outcome = error?.match(/^delivery outcome: (pending|unreachable|not-landed|no-session|failed)$/)?.[1];
  return outcome ? DELIVERY_FAILURE_COPY[outcome as keyof typeof DELIVERY_FAILURE_COPY] : error ?? null;
}
