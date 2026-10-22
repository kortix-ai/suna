/**
 * The v1 mirror rows an old session left behind (`session_transcript_*`). Nothing in the API
 * writes them since P8.2; a test seeds them to prove the conversion paths
 * (`writeSessionLogFromMirror`, `convertMirrorOnRead`, the backfill). The rows go through the
 * projection the old capture used (`mirrorRowsFromOpencodePayload`), so they have its shape.
 */
import { sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { mirrorRowsFromOpencodePayload } from '../../projects/lib/session-transcript-mirror';
import { db } from '../../shared/db';

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const time = (info: Record<string, unknown>, key: 'created' | 'completed'): Date | null => {
  const value = (info.time as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' && value > 0 ? new Date(value) : null;
};

/** Seed (or extend) one session's mirror: `root`'s messages and each child's, all under `root` as the mirror root. */
export async function seedV1Mirror(
  scope: { sessionId: string; projectId: string; accountId: string },
  root: string,
  payload: Msg[],
  children: Array<{ id: string; payload: Msg[] }> = [],
): Promise<void> {
  const now = new Date();
  await db
    .insert(sessionTranscriptMirrors)
    .values({ ...scope, runtimeSessionId: root, headComplete: true, capturedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: sessionTranscriptMirrors.sessionId, set: { runtimeSessionId: root, capturedAt: now, updatedAt: now } });
  const rows = [
    ...mirrorRowsFromOpencodePayload(payload).map((row) => ({ row, runtime: root })),
    ...children.flatMap((child) => mirrorRowsFromOpencodePayload(child.payload).map((row) => ({ row, runtime: child.id }))),
  ];
  if (rows.length === 0) return;
  await db
    .insert(sessionTranscriptMessages)
    .values(
      rows.map(({ row, runtime }) => ({
        sessionId: scope.sessionId,
        messageId: String(row.info.id),
        parentMessageId: typeof row.info.parentID === 'string' ? row.info.parentID : null,
        runtimeSessionId: runtime,
        role: typeof row.info.role === 'string' ? row.info.role : 'unknown',
        messageCreatedAt: time(row.info, 'created'),
        messageCompletedAt: time(row.info, 'completed'),
        info: row.info,
        parts: row.parts as unknown[],
        capturedAt: now,
      })),
    )
    .onConflictDoNothing();
}
