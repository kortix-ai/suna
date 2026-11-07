/**
 * A link to one message of a session: `?m=<message_id>&at=<epoch ms>`.
 *
 * The gateway request log links each model call to the session that made it
 * (`projectSessionMessageHref`). `m` names the message the call produced (an
 * assistant reply) or the prompt it answered; `at` is when the call started.
 * Rows written before calls carried a message id have only `at`, and a reply
 * of a sub-thread the open thread does not hold falls back to `at` too.
 */
import type { SessionLogTurn } from '@kortix/sdk';

/** The query parameter that names the message. */
export const MESSAGE_LINK_PARAM = 'm';
/** The query parameter that names the instant, in epoch ms. */
export const MESSAGE_LINK_AT_PARAM = 'at';

export interface MessageLinkTarget {
  messageId: string | null;
  /** Epoch ms; null when absent or not a number. */
  at: number | null;
}

/** The target a URL names, or null when it names none. */
export function readMessageLinkParams(params: Pick<URLSearchParams, 'get'> | null | undefined): MessageLinkTarget | null {
  const messageId = params?.get(MESSAGE_LINK_PARAM)?.trim() || null;
  const rawAt = params?.get(MESSAGE_LINK_AT_PARAM)?.trim();
  const at = rawAt && /^\d+$/.test(rawAt) ? Number(rawAt) : null;
  return messageId || at !== null ? { messageId, at } : null;
}

/** `params` without the message link, for the URL after the jump. */
export function deleteMessageLinkParams(params: URLSearchParams): void {
  params.delete(MESSAGE_LINK_PARAM);
  params.delete(MESSAGE_LINK_AT_PARAM);
}

function msOf(iso: string | null | undefined): number | null {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** When the turn began: its prompt, else its first reply (a partial turn's prompt is not loaded). */
function turnStartedAt(turn: Pick<SessionLogTurn, 'user' | 'assistant' | 'partial'>): number | null {
  return (turn.partial ? null : msOf(turn.user.created_at)) ?? msOf(turn.assistant[0]?.created_at);
}

/**
 * The key (`turn.id`, the `data-turn-id` anchor) of the turn the target names.
 *
 * By id first: the turn whose prompt or one of whose replies is `messageId`.
 * Else by time: the last turn that began at or before `at`. A time before the
 * first loaded turn names no turn: the caller loads older pages and asks again.
 */
export function resolveMessageLinkTurn(
  turns: ReadonlyArray<Pick<SessionLogTurn, 'id' | 'user' | 'assistant' | 'partial'>>,
  target: MessageLinkTarget,
): string | undefined {
  if (target.messageId) {
    const id = target.messageId;
    const byId = turns.find(
      (turn) => turn.id === id || turn.user.message_id === id || turn.assistant.some((reply) => reply.message_id === id),
    );
    if (byId) return byId.id;
  }
  if (target.at === null) return undefined;
  let found: string | undefined;
  for (const turn of turns) {
    const started = turnStartedAt(turn);
    if (started === null) continue;
    if (started > target.at) break;
    found = turn.id;
  }
  return found;
}
