/**
 * The snapshot a response share publishes: one assistant response (one turn),
 * read from the session log (`session_log_messages`, the store both harnesses
 * journal into). The turn is keyed by its user message id; its response is the
 * assistant messages whose `reply_to` names it (the same grouping as the SDK's
 * `SessionLogTurn`).
 *
 * Only visible `text` blocks are published. Reasoning, tool calls and output,
 * attachments, synthetic harness text, and the user prompt never are.
 */
import { sessionLogMessages } from '@kortix/db';
import type { SessionLogMessage } from '@kortix/api-contract/session-log';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ResponseSnapshot } from '../../shared/session-public-shares';
import { rehydrateLargeTexts } from '../session-log-blobs';
import { isPlaceholderOpencodeTitle } from './opencode-title';

/** The session's display title: the user's rename, else a real auto title. */
function sessionTitle(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const custom = typeof meta.custom_name === 'string' ? meta.custom_name.trim() : '';
  if (custom) return custom;
  const auto = typeof meta.name === 'string' ? meta.name.trim() : '';
  return auto && !isPlaceholderOpencodeTitle(auto) ? auto : null;
}

/** The response text of one assistant message: its non-synthetic text blocks. */
function textOf(message: SessionLogMessage): string[] {
  return (message.blocks ?? [])
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text' && !b.synthetic && !!b.text.trim())
    .map((b) => b.text.trim());
}

export type ResponseSnapshotResult =
  | { ok: true; snapshot: ResponseSnapshot }
  | { ok: false; status: 404 | 409; error: string };

export async function buildResponseSnapshot(input: {
  sessionId: string;
  projectId: string;
  turnId: string;
  sessionMetadata: unknown;
}): Promise<ResponseSnapshotResult> {
  const live = and(eq(sessionLogMessages.sessionId, input.sessionId), isNull(sessionLogMessages.deletedAt));
  const [prompt] = await db
    .select({ messageId: sessionLogMessages.messageId })
    .from(sessionLogMessages)
    .where(and(live, eq(sessionLogMessages.messageId, input.turnId), eq(sessionLogMessages.role, 'user')))
    .limit(1);
  if (!prompt) return { ok: false, status: 404, error: 'Turn not found' };

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
  // F3: a text over 256 kB is a preview in the row; publish the whole text.
  const messages = await rehydrateLargeTexts(
    { projectId: input.projectId, sessionId: input.sessionId },
    rows.map((r) => r.record as unknown as SessionLogMessage),
  );
  const markdown = messages.flatMap(textOf).join('\n\n');
  if (!markdown) return { ok: false, status: 409, error: 'This response has no text to share yet' };

  const last = messages.at(-1)!;
  const named = [...messages].reverse();
  return {
    ok: true,
    snapshot: {
      title: sessionTitle(input.sessionMetadata) ?? markdown.split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 80),
      markdown,
      agent_name: named.find((m) => m.agent)?.agent ?? null,
      model_id: named.find((m) => m.model?.model)?.model?.model ?? null,
      responded_at: last.completed_at ?? last.created_at,
    },
  };
}
