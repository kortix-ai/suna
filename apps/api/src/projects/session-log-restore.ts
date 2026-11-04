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
 * answer is `SessionLogRestoreTooLarge` (413) with the part of the log that `sessionLogRestorePlan` fits
 * under the cap (`kept`), every rev, `seq_max` and the blobs of that part. The plan reads light columns,
 * the record sizes and the last compaction of each thread; only the records of the part leave Postgres.
 *
 * A stored log can lack parts of a `SessionLog`: a session record built only from a
 * first batch without a session patch, or messages whose thread was never upserted.
 * The answer fills them from the `session_logs` columns and neutral defaults, so it
 * always parses as a `SessionLog`.
 */
import {
  SESSION_LOG_SCHEMA,
  modelViewSliceIds,
  type SessionLog,
  type SessionLogBlock,
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
 * A log over `SESSION_LOG_RESTORE_MAX_BYTES` is claimed and answered with the part that fits (`error` is set).
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
    if (bytes <= limit) return readLog(tx, log, null);
    const plan = await sessionLogRestorePlan(tx, scope.sessionId, limit);
    const answer = await readLog(tx, log, plan ?? { ids: new Set(), threads: null });
    return { ...answer, error: 'session_log_too_large', bytes, limit, messages: messages - (plan?.ids.size ?? 0), ...(plan && { kept: plan.kept }) };
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

/** True when a restore gives the model its whole context: the log is under the cap, or its model view is (`kept: 'model_view'`). */
export async function sessionLogRestoreKeepsModelView(tx: Pick<Tx, 'select' | 'execute'>, sessionId: string): Promise<boolean> {
  const limit = config.SESSION_LOG_RESTORE_MAX_BYTES;
  if ((await sessionLogRestoreBytes(tx, sessionId)).bytes <= limit) return true;
  return (await sessionLogRestorePlan(tx, sessionId, limit))?.kept === 'model_view';
}

/** The messages (`ids`) and threads an over-cap restore answers. */
export type SessionLogRestorePlan = { kept: 'model_view' | 'newest'; ids: Set<string>; threads: Set<string> };
type Named = Map<string, Array<{ sha256: string; bytes: number }>>;

/** Adds messages at the restore cost rule (`sessionLogRestoreBytes`) while they fit; a blob two messages name counts once. */
class Budget {
  private records = 0;
  private blobs = 0;
  private readonly counted = new Set<string>();
  constructor(private readonly limit: number, private readonly size: Map<string, number>, private readonly named: Named) {}
  /** Adds every message of `ids` and answers true, or adds none and answers false. */
  take(ids: Iterable<string>): boolean {
    let records = this.records;
    let blobs = this.blobs;
    const fresh = new Set<string>();
    for (const id of ids) {
      records += this.size.get(id) ?? 0;
      for (const b of this.named.get(id) ?? []) {
        if (this.counted.has(b.sha256) || fresh.has(b.sha256)) continue;
        fresh.add(b.sha256);
        blobs += b.bytes;
      }
    }
    if (records + Math.ceil(blobs * SESSION_LOG_BLOB_WEIGHT) > this.limit) return false;
    this.records = records;
    this.blobs = blobs;
    for (const sha of fresh) this.counted.add(sha);
    return true;
  }
}

/**
 * What a restore over `limit` answers (P6.1 follow-up). The model never sees the whole log: `modelViewSliceIds`
 * of a thread gives the model the context it had. The root thread's slice first; then each sub-agent thread's
 * slice, newest first, whole or not at all: `model_view`. A root slice over `limit` alone: the root's newest
 * in-context turns that fit, from the first user turn among them, so no turn is cut: `newest`. Null when not even
 * the newest turn fits. The cost is `sessionLogRestoreBytes`'s rule on the messages kept: their stored JSON plus
 * 2/5 of the blobs they name. Only light columns, the record sizes, the last compaction of each thread and the
 * blob refs of the slices are read; no record leaves Postgres.
 * ponytail: `newest` drops the summary too; keeping it needs a synthesized `layout` compaction, add it when the
 * fallback is common.
 */
export async function sessionLogRestorePlan(tx: Pick<Tx, 'select' | 'execute'>, sessionId: string, limit: number): Promise<SessionLogRestorePlan | null> {
  const rows = await tx
    .select({
      message_id: sessionLogMessages.messageId,
      thread_id: sessionLogMessages.threadId,
      seq: sessionLogMessages.seq,
      role: sessionLogMessages.role,
      kind: sql<SessionLogMessage['kind']>`${sessionLogMessages.kind}`,
      in_context: sessionLogMessages.inContext,
      bytes: sql<number>`octet_length(${sessionLogMessages.record}::text)`.mapWith(Number),
    })
    .from(sessionLogMessages)
    .where(and(eq(sessionLogMessages.sessionId, sessionId), isNull(sessionLogMessages.deletedAt)))
    .orderBy(asc(sessionLogMessages.seq), asc(sessionLogMessages.messageId));
  const byThread = new Map<string, Array<(typeof rows)[number] & { blocks?: SessionLogBlock[] }>>();
  for (const r of rows) (byThread.get(r.thread_id) ?? byThread.set(r.thread_id, []).get(r.thread_id)!).push(r);
  // The last in-context compaction of each thread is the only record the slice rule reads.
  const markers = [...byThread.values()].flatMap((t) => t.filter((r) => r.kind === 'compaction' && r.in_context).slice(-1));
  if (markers.length) {
    const blocks = await tx
      .select({ id: sessionLogMessages.messageId, blocks: sql<SessionLogBlock[]>`${sessionLogMessages.record}->'blocks'` })
      .from(sessionLogMessages)
      .where(and(eq(sessionLogMessages.sessionId, sessionId), sql`${sessionLogMessages.messageId} = ANY(${sql.param(markers.map((m) => m.message_id))}::text[])`));
    for (const m of markers) m.blocks = blocks.find((b) => b.id === m.message_id)?.blocks;
  }
  const slices = new Map([...byThread].map(([id, t]) => [id, modelViewSliceIds(t)]));
  const sliceIds = [...slices.values()].flatMap((ids) => [...ids]);
  const named: Named = new Map();
  if (sliceIds.length) {
    const refs = await tx.execute<{ message_id: string; sha256: string; bytes: string }>(sql`
      SELECT DISTINCT m.message_id, b.sha256, b.bytes
      FROM kortix.session_log_messages m
      CROSS JOIN LATERAL jsonb_path_query(m.record, 'lax $.**.ref') AS r(ref)
      JOIN kortix.session_log_blobs b ON b.session_id = m.session_id AND b.deleted_at IS NULL AND 'kortix-attachment://' || b.object_key = r.ref #>> '{}'
      WHERE m.session_id = ${sessionId} AND m.message_id = ANY(${sql.param(sliceIds)}::text[])`);
    for (const r of refs) (named.get(r.message_id) ?? named.set(r.message_id, []).get(r.message_id)!).push({ sha256: r.sha256, bytes: Number(r.bytes) });
  }
  const size = new Map(rows.map((r) => [r.message_id, r.bytes]));
  const budget = new Budget(limit, size, named);

  // The threads in the answer's order (`readLog`); the root is the first without a parent, as the daemon picks it.
  const records = await tx
    .select({ threadId: sessionLogThreads.threadId, parent: sessionLogThreads.parentThreadId })
    .from(sessionLogThreads)
    .where(eq(sessionLogThreads.sessionId, sessionId))
    .orderBy(asc(sessionLogThreads.createdAt), asc(sessionLogThreads.threadId));
  const order = [...records, ...[...byThread.keys()].filter((id) => !records.some((t) => t.threadId === id)).map((threadId) => ({ threadId, parent: null }))];
  const root = (order.find((t) => t.parent === null) ?? order[0])?.threadId;
  if (root === undefined) return null;

  const plan: SessionLogRestorePlan = { kept: 'model_view', ids: new Set(), threads: new Set([root]) };
  const rootSlice = slices.get(root) ?? new Set<string>();
  if (budget.take(rootSlice)) for (const id of rootSlice) plan.ids.add(id);
  else {
    const turns = (byThread.get(root) ?? []).filter((r) => rootSlice.has(r.message_id) && r.in_context && r.kind === 'turn');
    const trial = new Budget(limit, size, named);
    let start = turns.length;
    while (start > 0 && trial.take([turns[start - 1]!.message_id])) start--;
    while (start < turns.length && turns[start]!.role !== 'user') start++;
    if (start === turns.length) return null;
    plan.kept = 'newest';
    for (const r of turns.slice(start)) plan.ids.add(r.message_id);
    budget.take(plan.ids);
  }
  for (const { threadId } of [...order].reverse()) {
    const slice = slices.get(threadId) ?? new Set<string>();
    if (threadId === root || !budget.take(slice)) continue;
    plan.threads.add(threadId);
    for (const id of slice) plan.ids.add(id);
  }
  return plan;
}

/**
 * `keep` null: the whole log. Otherwise only the records of `keep.ids`, and only the threads of `keep.threads`
 * (null: every thread); every rev and seq either way. The blobs are the texts the answered records name.
 */
async function readLog(tx: Tx, log: LogRow, keep: { ids: ReadonlySet<string>; threads: ReadonlySet<string> | null } | null): Promise<SessionLogRestore> {
  const sessionId = log.sessionId;
  const threads = await tx
    .select({ threadId: sessionLogThreads.threadId, record: sessionLogThreads.record })
    .from(sessionLogThreads)
    .where(eq(sessionLogThreads.sessionId, sessionId))
    .orderBy(asc(sessionLogThreads.createdAt), asc(sessionLogThreads.threadId));
  const only = keep && sql`${sessionLogMessages.messageId} = ANY(${sql.param([...keep.ids])}::text[])`;
  // `rev` through the drizzle column (`bigint`, mode number): a JSON number.
  const messages = await tx
    .select({
      messageId: sessionLogMessages.messageId,
      threadId: sessionLogMessages.threadId,
      seq: sessionLogMessages.seq,
      rev: sessionLogMessages.rev,
      deletedAt: sessionLogMessages.deletedAt,
      record: !keep ? sessionLogMessages.record : sql<Record<string, unknown> | null>`CASE WHEN ${only} THEN ${sessionLogMessages.record} END`,
      toolInputOrder: !keep ? sessionLogMessages.toolInputOrder : sql<unknown[] | null>`CASE WHEN ${only} THEN ${sessionLogMessages.toolInputOrder} END`,
    })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, sessionId))
    .orderBy(asc(sessionLogMessages.seq), asc(sessionLogMessages.messageId));
  const stored = keep && !keep.ids.size
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
    const record = m.record === null ? null : withToolInputOrder(m.record as unknown as SessionLogMessage, m.toolInputOrder);
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
  const answered = [...byThread.values()].filter((t) => !keep?.threads || keep.threads.has(t.thread_id));
  return { generation: log.generation, log: { ...session, threads: answered }, revs, seq_max: seqMax, blobs } as SessionLogRestore;
}
