/**
 * WHO MAY REWIND A SESSION: the person who sent the message, and only when
 * nobody else sent one after it.
 *
 * A rewind (OpenCode `POST /session/:id/revert`, the web's "Edit message")
 * deletes the target message and every message after it. In a channel thread
 * other members write too, so a rewind must not delete or rewrite another
 * person's message. The prompt ledger names each sender (`continue_session`
 * rows, the same source as `session-message-authors.ts`). An agent's prompt
 * (`authorSessionId`) or a trigger's has no person behind it and blocks no one.
 * A message the ledger does not hold (the first prompt of an older session) is
 * the thread starter's.
 */
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export type RewindLedgerRow = {
  /** Every wire id the prompt travelled under. */
  ids: readonly string[];
  /** The person who sent it; null for an agent session or a system prompt. */
  sender: string | null;
};

/** Pure: may `userId` rewind to before `messageId`, given the ledger in send order? */
export function decideRewind(input: {
  rows: readonly RewindLedgerRow[];
  messageId: string;
  userId: string;
  sessionCreatedBy: string | null;
}): boolean {
  const { rows, messageId, userId } = input;
  const at = rows.findIndex((row) => row.ids.includes(messageId));
  const targetSender = at === -1 ? input.sessionCreatedBy : (rows[at]!.sender ?? input.sessionCreatedBy);
  if (targetSender !== userId) return false;
  // Unknown target: it predates the ledger, so every recorded row comes after it.
  return rows.slice(at === -1 ? 0 : at + 1).every((row) => row.sender === null || row.sender === userId);
}

function wireIds(payload: Record<string, unknown>, result: Record<string, unknown> | null): string[] {
  const ids = [
    payload.wireMessageId,
    payload.redeliveredMessageId,
    result?.forwarded_message_id,
    ...(Array.isArray(payload.redeliveredMessageIds) ? payload.redeliveredMessageIds : []),
  ];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** May person `userId` rewind session `sessionId` to before `messageId`? */
export async function mayRewindSession(sessionId: string, userId: string, messageId: string): Promise<boolean> {
  const [rows, [session]] = await Promise.all([
    db
      .select({
        actorUserId: sessionLifecycleCommands.actorUserId,
        payload: sessionLifecycleCommands.payload,
        result: sessionLifecycleCommands.result,
      })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          sql`${sessionLifecycleCommands.payload} ? 'clientMessageId'`,
        ),
      )
      .orderBy(asc(sessionLifecycleCommands.createdAt)),
    db.select({ createdBy: projectSessions.createdBy }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1),
  ]);
  return decideRewind({
    rows: rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        ids: wireIds(payload, row.result as Record<string, unknown> | null),
        sender: typeof payload.authorSessionId === 'string' ? null : (row.actorUserId ?? null),
      };
    }),
    messageId,
    userId,
    sessionCreatedBy: session?.createdBy ?? null,
  });
}
