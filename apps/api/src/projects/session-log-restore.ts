/**
 * The session-log restore (P6.1): `POST .../log/restore`. The daemon of a fresh box
 * calls it once, before its harness starts, and writes the answer into the harness's
 * native store (P6.2 pi, P6.3 OpenCode). Wire: `SessionLogRestore` in
 * `@kortix/api-contract/session-log` (`wire.ts`).
 *
 * One transaction under the session's advisory lock, the lock every journal and
 * capture batch takes (`session-log-ingest.ts`):
 * - The claim. `session_logs.generation` goes up by 1, and the box journals under the
 *   new value. A box still posting at an older one gets 409 from the ingest and stops.
 *   `updated_at` stays: it means "the log's last write", and the v1 reads compare it
 *   with the mirror (`session-log-read.ts`). A claim writes no content.
 * - The read. The lock keeps every batch out between the claim and the read, so the
 *   answer is the whole log at the claimed generation: nothing lands in between.
 *
 * `seq_max` is the highest seq each thread holds, tombstones included: a restored box
 * numbers its next message above it, so it never collides on (session, thread, seq).
 *
 * Records are served as stored, with each tool_call input in the key order the
 * harness wrote (`session-log-input-order.ts`; jsonb sorts keys). A text over 256 kB
 * is its 16 kB preview; `blobs` names each one, and the daemon reads the full text
 * through the attachments route with its own credential. The API never holds a
 * session's full texts in memory here.
 *
 * The cap. Before any record leaves Postgres, `sessionLogRestoreBytes` (what a restore costs the box:
 * the live records' stored JSON lengths plus the bytes of the session's live blobs, the full texts and
 * attachments it reads after the answer, at `SESSION_LOG_BLOB_WEIGHT`) is compared with
 * `SESSION_LOG_RESTORE_MAX_BYTES`.
 * The size query reads the records inside Postgres only. Above the cap the claim stands and the
 * answer is `SessionLogRestoreTooLarge` (413): every thread without messages, every rev, `seq_max`,
 * no blob. The API holds ids and seqs only; the box writes the D3 note alone.
 * ponytail: the whole history is left out; restore the newest messages under the cap (paging) when
 * sessions near the cap are common.
 *
 * A stored log can lack parts of a `SessionLog`: a session record built only from a
 * first batch without a session patch, or messages whose thread was never upserted.
 * The answer fills them from the `session_logs` columns and neutral defaults, so it
 * always parses as a `SessionLog`.
 */
import {
  SESSION_LOG_SCHEMA,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogRestore,
  type SessionLogRestoreBlob,
  type SessionLogRestoreTooLarge,
} from '@kortix/api-contract/session-log';
import { sessionLogBlobs, sessionLogMessages, sessionLogs, sessionLogThreads } from '@kortix/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { referencedTexts } from './session-log-blobs';
import { withToolInputOrder } from './session-log-input-order';
import type { SessionLogScope } from './session-log-ingest';

type Thread = SessionLog['threads'][number];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LogRow = typeof sessionLogs.$inferSelect;

/**
 * Claim the session and read its log, or null when the session has no stored log (nothing claimed).
 * A log over `SESSION_LOG_RESTORE_MAX_BYTES` is claimed and answered without messages (`error` is set).
 */
export async function claimSessionLog(scope: SessionLogScope): Promise<SessionLogRestore | SessionLogRestoreTooLarge | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`session-log:${scope.sessionId}`}))`);
    const [log] = await tx
      .update(sessionLogs)
      .set({ generation: sql`${sessionLogs.generation} + 1` })
      .where(
        and(
          eq(sessionLogs.sessionId, scope.sessionId),
          eq(sessionLogs.projectId, scope.projectId),
          eq(sessionLogs.accountId, scope.accountId),
        ),
      )
      .returning();
    if (!log) return null;
    const { bytes, messages } = await sessionLogRestoreBytes(tx, scope.sessionId);
    const limit = config.SESSION_LOG_RESTORE_MAX_BYTES;
    if (bytes <= limit) return readWholeLog(tx, log, true);
    return { ...(await readWholeLog(tx, log, false)), error: 'session_log_too_large', bytes, limit, messages };
  });
}

/**
 * Daemon memory per blob byte, relative to a record byte. Measured on a real pi box: a 38.5 MB log
 * of records peaked the daemon at +1.45 GB (~38x), 30 MB of image blobs at +455 MB (~15x); 15/38 ≈ 0.39,
 * rounded up to 2/5. The cap then means the same daemon peak (about 1 GB) for records and for blobs.
 */
export const SESSION_LOG_BLOB_WEIGHT = 2 / 5;

/**
 * What a restore of the session costs the box, in record-equivalent bytes: the live records' stored
 * JSON lengths plus the bytes of the session's live blobs (texts over 256 kB, attachments) times
 * `SESSION_LOG_BLOB_WEIGHT`, rounded up. `messages`: the live messages.
 */
export async function sessionLogRestoreBytes(tx: Pick<Tx, 'execute'>, sessionId: string): Promise<{ bytes: number; messages: number }> {
  const [row] = await tx.execute<{ records: string; blobs: string; messages: number }>(sql`
    SELECT
      (SELECT coalesce(sum(octet_length(record::text)), 0) FROM kortix.session_log_messages WHERE session_id = ${sessionId} AND deleted_at IS NULL) AS records,
      (SELECT coalesce(sum(bytes), 0) FROM kortix.session_log_blobs WHERE session_id = ${sessionId} AND deleted_at IS NULL) AS blobs,
      (SELECT count(*)::int FROM kortix.session_log_messages WHERE session_id = ${sessionId} AND deleted_at IS NULL) AS messages`);
  return { bytes: Number(row?.records ?? 0) + Math.ceil(Number(row?.blobs ?? 0) * SESSION_LOG_BLOB_WEIGHT), messages: Number(row?.messages ?? 0) };
}

/** True when a restore of the session is under `SESSION_LOG_RESTORE_MAX_BYTES` (no 413). */
export async function sessionLogRestoreFits(tx: Pick<Tx, 'execute'>, sessionId: string): Promise<boolean> {
  return (await sessionLogRestoreBytes(tx, sessionId)).bytes <= config.SESSION_LOG_RESTORE_MAX_BYTES;
}

/** `full` false: every thread, rev and seq, no message record and no blob (the 413 answer). */
async function readWholeLog(tx: Tx, log: LogRow, full: boolean): Promise<SessionLogRestore> {
  const sessionId = log.sessionId;
  const threads = await tx
    .select({ threadId: sessionLogThreads.threadId, record: sessionLogThreads.record })
    .from(sessionLogThreads)
    .where(eq(sessionLogThreads.sessionId, sessionId))
    .orderBy(asc(sessionLogThreads.createdAt), asc(sessionLogThreads.threadId));
  // `rev` through the drizzle column (`bigint`, mode number): a JSON number.
  const messages = await tx
    .select({
      messageId: sessionLogMessages.messageId,
      threadId: sessionLogMessages.threadId,
      seq: sessionLogMessages.seq,
      rev: sessionLogMessages.rev,
      deletedAt: sessionLogMessages.deletedAt,
      record: full ? sessionLogMessages.record : sql<null>`null`,
      toolInputOrder: full ? sessionLogMessages.toolInputOrder : sql<null>`null`,
    })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, sessionId))
    .orderBy(asc(sessionLogMessages.seq), asc(sessionLogMessages.messageId));
  const stored = !full
    ? []
    : await tx
        .select({ objectKey: sessionLogBlobs.objectKey, sha256: sessionLogBlobs.sha256, bytes: sessionLogBlobs.bytes })
        .from(sessionLogBlobs)
        .where(and(eq(sessionLogBlobs.sessionId, sessionId), isNull(sessionLogBlobs.deletedAt)));

  const byThread = new Map<string, Thread>(
    threads.map((t) => [t.threadId, { ...(t.record as unknown as Thread), messages: [] }]),
  );
  const objects = new Map(stored.map((b) => [`kortix-attachment://${b.objectKey}`, b]));
  const revs: Record<string, number> = {};
  const seqMax: Record<string, number> = {};
  const blobs: SessionLogRestoreBlob[] = [];
  for (const m of messages) {
    revs[m.messageId] = m.rev;
    seqMax[m.threadId] = Math.max(seqMax[m.threadId] ?? 0, m.seq);
    if (m.deletedAt !== null) continue;
    const record = full ? withToolInputOrder(m.record as unknown as SessionLogMessage, m.toolInputOrder) : null;
    let thread = byThread.get(m.threadId);
    if (!thread) {
      thread = { schema: SESSION_LOG_SCHEMA, v: log.v, thread_id: m.threadId, parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: record?.created_at ?? log.createdAt.toISOString(), messages: [], ext: {} };
      byThread.set(m.threadId, thread);
    }
    if (!record) continue;
    thread.messages.push(record);
    for (const t of referencedTexts(record)) {
      const object = objects.get(t.ref);
      if (object) blobs.push({ message_id: m.messageId, block_id: t.block_id, ref: t.ref, bytes: object.bytes, sha256: object.sha256 });
    }
  }

  const session = {
    schema: SESSION_LOG_SCHEMA,
    v: log.v,
    title: null,
    created_at: log.createdAt.toISOString(),
    restore_grade: log.restoreGrade,
    ...(log.gradeCounts && { grade_counts: log.gradeCounts }),
    harness: { current: log.harnessCurrent, history: [] },
    selection: { agent: null, model: null },
    todos: [],
    pending: { questions: [], permissions: [] },
    ext: {},
    ...log.record,
    session_id: sessionId,
  } as unknown as Omit<SessionLog, 'threads'>;
  return { generation: log.generation, log: { ...session, threads: [...byThread.values()] }, revs, seq_max: seqMax, blobs } as SessionLogRestore;
}
