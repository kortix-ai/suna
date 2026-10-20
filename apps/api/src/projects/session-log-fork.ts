import { sessionLogBlobs, sessionLogMessages, sessionLogs, sessionLogThreads, projectSessions } from '@kortix/db';
import { parseSessionAttachmentRef, sessionAttachmentRef } from '@kortix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { config } from '../config';
import { db } from '../shared/db';
import { sessionAttachmentStore } from './lib/session-attachments';
import { sessionLogContentHash } from './session-log-ingest';
import { sessionLogRestoreFits } from './session-log-restore';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Copy under the journal lock, before the destination row can provision. Blob bytes
 * get their own prefix: deleting either session cannot damage the other history. */
export async function copySessionLog(tx: Tx, input: {
  sourceId: string; sessionId: string; projectId: string; accountId: string;
  captureComplete?: boolean;
}): Promise<void> {
  if (!config.SESSION_LOG_RESTORE_ENABLED || !config.SESSION_LOG_INGEST_ENABLED) throw new HTTPException(503, { message: 'Session log restore is off' });
  const { sourceId, sessionId, projectId, accountId } = input;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`session-log:${sourceId}`}))`);
  const [source] = await tx.select().from(projectSessions).where(and(
    eq(projectSessions.sessionId, sourceId), eq(projectSessions.projectId, projectId), eq(projectSessions.accountId, accountId),
  )).for('share');
  if (!source || typeof source.metadata?.deletedAt === 'string') throw new HTTPException(404, { message: 'Fork source not found' });
  const [log] = await tx.select().from(sessionLogs).where(and(
    eq(sessionLogs.sessionId, sourceId), eq(sessionLogs.projectId, projectId), eq(sessionLogs.accountId, accountId),
  ));
  if (!log || !(await sessionLogRestoreFits(tx, sourceId))) {
    throw new HTTPException(409, { message: 'Source history is not available for a complete restore' });
  }
  if (!log.journalSeenAt && !input.captureComplete) {
    throw new HTTPException(409, { message: 'Source history capture is incomplete' });
  }
  const threads = await tx.select().from(sessionLogThreads).where(eq(sessionLogThreads.sessionId, sourceId));
  if (!threads.some((thread) => thread.parentThreadId === null)) throw new HTTPException(409, { message: 'Source history has no root thread' });
  const messages = await tx.select().from(sessionLogMessages).where(eq(sessionLogMessages.sessionId, sourceId));
  const blobs = await tx.select().from(sessionLogBlobs).where(eq(sessionLogBlobs.sessionId, sourceId));
  const copied = new Map<string, string>();
  async function copyRef(value: string): Promise<string> {
    const ref = parseSessionAttachmentRef(value);
    if (!ref) return value;
    if (ref.projectId !== projectId || ref.sessionId !== sourceId) {
      throw new HTTPException(409, { message: 'History contains an attachment outside the source session' });
    }
    const known = copied.get(value);
    if (known) return known;
    const bytes = await sessionAttachmentStore().read(ref);
    if (!bytes) throw new HTTPException(409, { message: 'Source attachment is unavailable' });
    const file = await sessionAttachmentStore().put({ ...ref, sessionId, filename: ref.attachmentId,
      mime: bytes.type || 'application/octet-stream', bytes: new Uint8Array(await bytes.arrayBuffer()) });
    copied.set(value, file.url);
    return file.url;
  }
  async function rewrite(value: unknown): Promise<unknown> {
    if (typeof value === 'string') return copyRef(value);
    if (Array.isArray(value)) return Promise.all(value.map(rewrite));
    if (value && typeof value === 'object') return rewriteRecord(value);
    return value;
  }
  async function rewriteRecord(value: object): Promise<Record<string, unknown>> {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await rewrite(item)])));
  }
  await tx.insert(sessionLogs).values({ ...log, sessionId, generation: 0, journalSeenAt: null,
    record: { ...await rewriteRecord(log.record), session_id: sessionId, title: `${String(log.record.title ?? 'Conversation')} (fork)` } });
  for (const thread of threads) await tx.insert(sessionLogThreads).values({ ...thread, sessionId, record: await rewriteRecord(thread.record) });
  for (const message of messages) {
    const record = await rewriteRecord(message.record);
    await tx.insert(sessionLogMessages).values({ ...message, sessionId, generation: 0, record, contentHash: sessionLogContentHash(record) });
  }
  for (const blob of blobs) {
    if (blob.deletedAt) continue;
    const ref = await copyRef(`kortix-attachment://${blob.objectKey}`);
    const parsed = parseSessionAttachmentRef(ref);
    if (!parsed) throw new HTTPException(409, { message: 'Invalid source blob reference' });
    await tx.insert(sessionLogBlobs).values({ ...blob, sessionId, objectKey: sessionAttachmentRef(parsed).slice('kortix-attachment://'.length) });
  }
}

/** Run outside the transaction: a rolled-back destination owns no durable log,
 * but Storage uploads are external side effects and must be removed separately.
 * Call only around insertion of a fresh destination (never a retry of an existing row).
 */
export async function withForkAttachmentCleanup<T>(
  projectId: string, sessionId: string, operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // A conflicting create may own this id already. Never purge its files.
    const [existing] = await db.select({ sessionId: projectSessions.sessionId }).from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId)).limit(1);
    if (!existing) await sessionAttachmentStore().removeSession(projectId, sessionId);
    throw error;
  }
}
