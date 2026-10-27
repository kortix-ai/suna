/**
 * The snapshot a response share publishes: one assistant response (one turn),
 * read from the session log (`session_log_messages`, the store both harnesses
 * journal into). The turn is keyed by its user message id; its response is the
 * assistant messages whose `reply_to` names it (the same grouping as the SDK's
 * `SessionLogTurn`).
 *
 * Only visible `text` blocks are published. Reasoning, tool calls and output,
 * attachments and synthetic harness text never are. The prompt's text is
 * published only when the sharer asks for it (`include_prompt`).
 */
import { sessionLogMessages, sessionTurns } from '@kortix/db';
import type { SessionLogMessage } from '@kortix/api-contract/session-log';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ResponseSnapshot } from '../../shared/session-public-shares';
import { rehydrateLargeTexts } from '../session-log-blobs';

/** Bytes a published snapshot may carry (response + prompt, UTF-8). */
export const MAX_PUBLISHED_BYTES = 256 * 1024;

/** Markdown syntax off one line: emphasis, code ticks, links/images to their text, quote and list markers. */
function plainLine(line: string): string {
  return line
    .slice(0, 4000)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+]\s+|\d+[.)]\s+)+/, '')
    .trim();
}

/**
 * The published title: the response's first heading, else its first non-empty
 * line, as plain text, at most 80 characters. Never the session title: the auto
 * title is a summary (or an excerpt) of the session's first prompt, so it would
 * publish prompt text on a "response only" share.
 */
export function responseTitle(markdown: string): string {
  const lines = markdown.split('\n');
  const heading = lines.find((l) => /^\s{0,3}#{1,6}\s+\S/.test(l));
  const first = heading ?? lines.find((l) => plainLine(l)) ?? '';
  return plainLine(first).slice(0, 80);
}

/** True when the published text would exceed `MAX_PUBLISHED_BYTES`. */
export function publishedTooLarge(markdown: string, prompt: string | null): boolean {
  const bytes = Buffer.byteLength(markdown, 'utf8') + (prompt === null ? 0 : Buffer.byteLength(prompt, 'utf8'));
  return bytes > MAX_PUBLISHED_BYTES;
}

/** The response text of one assistant message: its non-synthetic text blocks. */
function textOf(message: SessionLogMessage): string[] {
  return (message.blocks ?? [])
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text' && !b.synthetic && !!b.text.trim())
    .map((b) => b.text.trim());
}

export type ResponseSnapshotResult =
  | { ok: true; snapshot: ResponseSnapshot }
  | { ok: false; status: 404 | 409 | 413; error: string };

export const RESPONSE_NOT_FOUND_ERROR = 'Response not found';
export const RESPONSE_SAVING_ERROR = 'This response is still being saved. Try again in a few seconds.';
export const RESPONSE_STREAMING_ERROR = 'This response is still being written. Try again when it finishes.';
export const RESPONSE_EMPTY_ERROR = 'This response has no text to share yet';
export const RESPONSE_TOO_LARGE_ERROR = 'This response is too long to share publicly.';

/**
 * The answer when the prompt is not in the session log. A turn the ledger
 * (`session_turns`) knows is real: its messages have not reached the log yet
 * (the journal lags a settled turn by seconds, and a lost tunnel can drop its
 * posts until the daemon re-sends), so the caller retries → 409. A turn nobody
 * recorded → 404.
 */
export function unloggedTurnResult(turnRecorded: boolean): ResponseSnapshotResult {
  return turnRecorded
    ? { ok: false, status: 409, error: RESPONSE_SAVING_ERROR }
    : { ok: false, status: 404, error: RESPONSE_NOT_FOUND_ERROR };
}

export async function buildResponseSnapshot(input: {
  sessionId: string;
  projectId: string;
  turnId: string;
  /** Publish the prompt's text too. */
  includePrompt: boolean;
}): Promise<ResponseSnapshotResult> {
  const live = and(eq(sessionLogMessages.sessionId, input.sessionId), isNull(sessionLogMessages.deletedAt));
  const [prompt] = await db
    .select({ record: sessionLogMessages.record })
    .from(sessionLogMessages)
    .where(and(live, eq(sessionLogMessages.messageId, input.turnId), eq(sessionLogMessages.role, 'user')))
    .limit(1);
  if (!prompt) {
    const [turn] = await db
      .select({ turnToken: sessionTurns.turnToken })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.messageId, input.turnId)))
      .limit(1);
    return unloggedTurnResult(turn !== undefined);
  }

  const rows = await db
    .select({ record: sessionLogMessages.record })
    .from(sessionLogMessages)
    .where(
      and(
        live,
        eq(sessionLogMessages.role, 'assistant'),
        eq(sessionLogMessages.kind, 'turn'),
        sql`${sessionLogMessages.record} ->> 'reply_to' = ${input.turnId}`,
        // A failed attempt, a retracted, reverted or superseded reply is not the response.
        // An aborted reply keeps the text the user saw.
        sql`coalesce(${sessionLogMessages.record} ->> 'hidden_reason', 'aborted') = 'aborted'`,
      ),
    )
    .orderBy(asc(sessionLogMessages.seq));
  // Only a finished turn is published: a reply still streaming would freeze half an answer.
  if ((rows.at(-1)?.record as { status?: unknown } | undefined)?.status === 'streaming') {
    return { ok: false, status: 409, error: RESPONSE_STREAMING_ERROR };
  }
  // F3: a text over 256 kB is a preview in the row; publish the whole text.
  const [user, ...messages] = await rehydrateLargeTexts(
    { projectId: input.projectId, sessionId: input.sessionId },
    [prompt.record, ...rows.map((r) => r.record)] as unknown as SessionLogMessage[],
  );
  const markdown = messages.flatMap(textOf).join('\n\n');
  if (!markdown) return { ok: false, status: 409, error: RESPONSE_EMPTY_ERROR };
  // Text blocks only: attachments and files are never published.
  const promptText = input.includePrompt ? textOf(user!).join('\n\n') || null : null;
  if (publishedTooLarge(markdown, promptText)) return { ok: false, status: 413, error: RESPONSE_TOO_LARGE_ERROR };

  const last = messages.at(-1)!;
  return {
    ok: true,
    snapshot: {
      title: responseTitle(markdown),
      prompt: promptText,
      include_prompt: input.includePrompt,
      markdown,
      // Not published: a custom agent name can be internal. Kept in the type for old readers.
      agent_name: null,
      model_id: [...messages].reverse().find((m) => m.model?.model)?.model?.model ?? null,
      responded_at: last.completed_at ?? last.created_at,
    },
  };
}
