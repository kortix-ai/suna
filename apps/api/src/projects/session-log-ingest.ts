/**
 * The session-log journal ingest and manifest (P2.2): what kortixd's journal
 * (`apps/kortix-sandbox-agent-server/src/harness/shared/session-log-journal.ts`)
 * writes into `session_logs`, `session_log_threads` and `session_log_messages`.
 * The wire and its status codes are in `@kortix/api-contract/session-log` (`wire.ts`).
 *
 * One transaction per batch, under a per-session advisory lock:
 * - Generation fence. `session_logs.generation` is the session's generation. A
 *   batch with an older one answers 409 and writes nothing. An equal one is
 *   accepted. A newer one is accepted and becomes the session's (the restore
 *   claim mints them: `session-log-restore.ts`).
 * - Revisions. A put or a tombstone applies only when its (generation, rev) is
 *   above the stored message's. Every pair of the batch is acknowledged, applied
 *   or not, after commit. A higher put revives a tombstoned message.
 * - `seq` is unique per thread (`session_log_messages_thread_seq_key`). A put
 *   that collides rolls the whole batch back and answers 422 with its pair.
 * - Durable turns. The first acknowledged assistant message of a turn that is not
 *   streaming sets `session_turns.log_durable_at`: the turn whose `message_id` (the
 *   client-minted user message id) is the assistant message's `reply_to`. No
 *   assistant message answers a compaction: both harnesses fold the summary into
 *   the compaction message. So a compaction that is not streaming marks its
 *   `/summarize` turn itself, also when it failed or was aborted (`error` set),
 *   like an errored assistant reply. On OpenCode that turn's `message_id` is the
 *   compaction's id (the daemon's `turn_begin` names it). On pi the turn has no
 *   message id: the compaction marks the earliest unmarked id-less turn of its
 *   thread that started before the compaction completed and had not ended
 *   before it. Earliest, not latest: pi runs a `/summarize` on its serial queue
 *   and relays no turn end for it (the active-turn renewal pass ends it once the
 *   box is idle), so a later id-less turn (a second `/summarize`, a delivery
 *   without a wire id) can be open beside it; each compaction takes the oldest
 *   one still waiting. An auto compaction inside a prompt turn (an id) marks
 *   nothing unless an id-less turn is still open beside it. A later
 *   acknowledgement (a restarted daemon re-sends everything) keeps the first time.
 *   Known wrong marks of the pi rule (it marks the wrong turn and leaves the right
 *   one null):
 *   - a `/summarize` pi refused (nothing stored) that the reaper has not ended yet
 *     when the next compaction completes: that compaction marks it;
 *   - a re-sent compaction (a daemon restart, or a retried post whose response was
 *     lost) marks an id-less turn that started before it and is still open;
 *   - on such a replay, a box clock ahead of the API by more than the reaper's
 *     delay admits a turn that started after the compaction.
 *   Follow-up (the durable fix): pi `compact()` relays `turn_begin`/`turn_end`
 *   with the compaction marker id, so the id match works on both harnesses and
 *   the id-less rule goes.
 *
 * Records keep the values the daemon sent, not the zod parse: the parse drops
 * fields this API does not know, and the record would lose them (the same rule
 * as `upcast`). They do not keep its object key order: the column is jsonb.
 * Key order is not semantic in this schema (`same` in the contract's `v1.ts`),
 * and `canonicalizeView` sorts tool-input keys. One exception, F3: a text over 256 kB is stored as a
 * preview plus a reference to its object (`session-log-blobs.ts`). The objects
 * are written before the transaction. `content_hash` hashes the sanitized full
 * message before offload, not the stored preview/reference record. The daemon
 * reconciles by rev/seq, not by hash. A second
 * exception: a NUL and lone UTF-16 surrogates are replaced with U+FFFD
 * (`jsonbSafeValue`), because Postgres jsonb and text columns reject them
 * outright.
 *
 * Two writers, one apply path (`applyBatch`):
 * - The journal. Its first committed batch with a put or a tombstone sets
 *   `session_logs.journal_seen_at`.
 * - The transcript capture of a box without a journal (P2.7,
 *   `session-log-capture.ts`): `fromV1` of the v1 mirror, at generation 0, with
 *   revs below `SESSION_LOG_CAPTURE_REV_LIMIT`. It writes only while
 *   `journal_seen_at` is null, checked under the lock. A journal rev is a
 *   microsecond timestamp, always above the limit, so every journal put and
 *   tombstone wins over a capture row, and a capture put never overwrites a
 *   journal row. A capture row is provisional: a journal put that claims its
 *   `(thread_id, seq)` deletes it first (a seq collision between two journal
 *   rows stays 422). The capture's session patch replaces the session record
 *   (a `fromV1` field can disappear, such as a stale `root_id`); its tombstone
 *   moves the row to seq `-rev`, so the seqs `fromV1` gives the messages after a
 *   rewind stay free. The capture never sets `log_durable_at`: that column means
 *   "acknowledged by the daemon's journal".
 * - The upgrade (P3.3). A converted log (capture or backfill rows, grade `converted` or
 *   `partial`) becomes native at the journal's first write: `restore_grade` goes to
 *   `native`, and `grade_counts` goes from the column and the record. A capture row gives
 *   way only where the journal claims it: the same message id (the put replaces it), the
 *   same `(thread_id, seq)` (a tombstone at seq `-rev`), or a thread where a pi reply has a
 *   `pi:` id (a dump from before P2.5: every capture row of that thread is tombstoned, at
 *   generation 0 only). These rules apply in every batch. At generation 0, the first
 *   journal write also takes every other live capture row out of context (`in_context:
 *   false`, column and record): it stays visible, and the model view is the native
 *   store's. Capture rows are never deleted.
 * - Re-puts. A put whose content hash equals the stored row's (a restarted daemon re-sends
 *   every message) is acknowledged and changes nothing, unless the row is a tombstone, a
 *   capture row, or of another generation.
 */
import { createHash } from 'node:crypto';
import {
  SESSION_LOG_MINOR,
  type SessionLogJournalConflict,
  type SessionLogJournalRequest,
  type SessionLogJournalResponse,
  type SessionLogJournalSeqConflict,
  type SessionLogManifest,
  type SessionLogPut,
} from '@kortix/api-contract/session-log';
import { projectSessions, sessionLogMessages, sessionLogs, sessionLogThreads, sessionTurns } from '@kortix/db';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { uniqueViolationConstraint } from '../shared/postgres-errors';
import { logger } from '../lib/logger';
import { jsonbSafeValue } from './lib/jsonb-safe';
import { offloadLargeTexts } from './session-log-blobs';
import { toolInputOrderOf } from './session-log-input-order';

export interface SessionLogScope {
  sessionId: string;
  projectId: string;
  accountId: string;
}

export type SessionLogJournalOutcome =
  | { status: 200; body: SessionLogJournalResponse }
  | { status: 404; body: { error: string } }
  | { status: 409; body: SessionLogJournalConflict }
  | { status: 429; body: { error: string } }
  | { status: 422; body: SessionLogJournalSeqConflict };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SEQ_KEY = 'session_log_messages_thread_seq_key';

/**
 * Every rev the transcript capture writes is below this (2^31, so `-rev` fits
 * the int4 `seq` of a capture tombstone). Journal revs are microsecond
 * timestamps (~1.8e15), always above it: a journal write always wins.
 */
export const SESSION_LOG_CAPTURE_REV_LIMIT = 2 ** 31;

/** A capture write: `current` runs under the lock and answers false when a newer mirror capture ran. */
type CaptureWrite = { current: (tx: Tx) => Promise<boolean> };
const NO_SESSION = { status: 404, body: { error: 'Session not found' } } as const;
/**
 * Another batch of the session holds its lock. Waiting for it queued every retry of the
 * daemon behind a batch the daemon had already abandoned (its post times out at 15 s, the
 * transaction runs on), until the 25 s statement timeout cancelled the wait: 57014 in a loop,
 * hundreds per session (KRTX-2344). The daemon backs off on 429 and keeps its dirty set.
 */
const BUSY = { status: 429, body: { error: 'Session log busy' } } as const;

class SeqConflict extends Error {
  constructor(readonly body: SessionLogJournalSeqConflict) {
    super('seq_conflict');
  }
}

/** The session row, only when it belongs to this project and account. */
export async function sessionExists(scope: SessionLogScope): Promise<boolean> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, scope.sessionId),
        eq(projectSessions.projectId, scope.projectId),
        eq(projectSessions.accountId, scope.accountId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export const sessionLogContentHash = (message: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;

/**
 * Postgres jsonb and text columns reject a string carrying U+0000 or an
 * unpaired surrogate (`unsupported Unicode escape sequence`, 22P05; a raw NUL
 * byte in a text parameter, 22021): a harness reading binary output emits
 * UTF-16LE-like NUL padding or gzip bytes in tool text, JSON keeps them as
 * escapes, and ONE poisoned record failed the whole INSERT — which the daemon
 * then re-sent forever (243 5xx in a day, one 730 kB batch retried 171 times,
 * KRTX-211; the same shape with NULs, KRTX-2178). Replace every bad code unit
 * with U+FFFD before anything is hashed or written, the way a terminal renders
 * it. `jsonbSafeValue` (`lib/jsonb-safe.ts`) is the KRTX-1701-reviewed walker
 * the transcript mirror shares; unlike `toWellFormed`, it also strips NUL,
 * which is a well-formed string Postgres still refuses.
 */

/** Apply one journal batch. `batch` is the request body as sent, already validated by `SessionLogJournalRequestSchema`. */
export async function ingestSessionLogJournal(
  scope: SessionLogScope,
  request: SessionLogJournalRequest,
): Promise<SessionLogJournalOutcome> {
  return (await applyBatch(scope, request, null)) as SessionLogJournalOutcome;
}

/**
 * Apply one capture batch (P2.7). 'skipped' when a journal has written for the
 * session, the session generation moved on, or `current` answered false.
 */
export async function writeCapturedSessionLog(
  scope: SessionLogScope,
  batch: SessionLogJournalRequest,
  current: CaptureWrite['current'],
): Promise<SessionLogJournalOutcome | 'skipped'> {
  const outcome = await applyBatch(scope, batch, { current });
  return outcome !== 'skipped' && outcome.status === 409 ? 'skipped' : outcome;
}

async function applyBatch(
  scope: SessionLogScope,
  request: SessionLogJournalRequest,
  capture: CaptureWrite | null,
): Promise<SessionLogJournalOutcome | 'skipped'> {
  const batch = jsonbSafeValue(request);
  if (!(await sessionExists(scope))) return NO_SESSION;
  // One put at a time: at most one large text is in memory twice.
  const records: SessionLogPut['message'][] = [];
  for (const put of batch.puts) records.push(await offloadLargeTexts(scope, put.message));
  try {
    return await db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`session-log:${scope.sessionId}`})) AS locked`,
      );
      if (!lock?.locked) return capture ? ('skipped' as const) : BUSY;
      if (capture && !(await capture.current(tx))) return 'skipped' as const;
      const current = await upsertSession(tx, scope, batch, capture !== null);
      if (current === 'journal') return 'skipped' as const;
      if (current !== null) return { status: 409 as const, body: { generation: current } };
      await upsertThreads(tx, scope.sessionId, batch);
      // Tombstones first: a capture tombstone frees the seq a put of the same batch takes.
      for (const t of batch.tombstones) {
        await tx
          .update(sessionLogMessages)
          .set({
            deletedAt: sql`now()`,
            rev: t.rev,
            generation: batch.generation,
            ...(capture && { seq: -t.rev }),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(sessionLogMessages.sessionId, scope.sessionId),
              eq(sessionLogMessages.messageId, t.message_id),
              sql`(${batch.generation}::int, ${t.rev}::bigint) > (${sessionLogMessages.generation}, ${sessionLogMessages.rev})`,
            ),
          );
      }
      // Generation 0 only: a restore (P6.2) writes `pi:` replies itself, into a store built from this log.
      if (!capture && batch.generation === 0) await hideConvertedPiThreads(tx, scope.sessionId, batch.puts);
      await dropProvisionalRows(tx, scope.sessionId, batch.puts);
      for (const [i, put] of batch.puts.entries()) await applyPut(tx, scope.sessionId, batch.generation, put, records[i]!);
      if (!capture) await markDurableTurns(tx, scope.sessionId, batch.puts);
      const acked = [
        ...batch.puts.map((p) => ({ message_id: p.message.message_id, rev: p.rev })),
        ...batch.tombstones.map((t) => ({ message_id: t.message_id, rev: t.rev })),
      ];
      return { status: 200 as const, body: { acked } };
    });
  } catch (err) {
    if (err instanceof SeqConflict) return { status: 422, body: err.body };
    throw err;
  }
}

/**
 * Create or update the `session_logs` row and fence the generation. Returns the
 * session's generation when the batch's is older (nothing was written),
 * 'journal' for a capture after the journal wrote, else null.
 */
async function upsertSession(
  tx: Tx,
  scope: SessionLogScope,
  batch: SessionLogJournalRequest,
  capture: boolean,
): Promise<number | 'journal' | null> {
  const [row] = await tx
    .select({ generation: sessionLogs.generation, journalSeenAt: sessionLogs.journalSeenAt })
    .from(sessionLogs)
    .where(eq(sessionLogs.sessionId, scope.sessionId))
    .limit(1);
  if (capture && row?.journalSeenAt) return 'journal';
  // A batch with no put and no tombstone (the boot session patch, the empty flush at stop) proves no journal:
  // the capture keeps writing until a message arrives.
  const writes = batch.puts.length + batch.tombstones.length > 0;
  if (row && batch.generation < row.generation) return row.generation;
  const patch = batch.session;
  if (!row) {
    await tx.insert(sessionLogs).values({
      sessionId: scope.sessionId,
      projectId: scope.projectId,
      accountId: scope.accountId,
      generation: batch.generation,
      v: patch?.v ?? SESSION_LOG_MINOR,
      // A first batch without a session patch still needs the NOT NULL columns;
      // the next patch overwrites them.
      harnessCurrent: patch?.harness?.current ?? batch.puts[0]?.message.producer.harness ?? 'unknown',
      restoreGrade: patch?.restore_grade ?? 'native',
      gradeCounts: patch?.grade_counts ?? null,
      record: (patch ?? {}) as Record<string, unknown>,
      journalSeenAt: capture || !writes ? null : sql`now()`,
    });
    return null;
  }
  const firstJournal = !capture && writes && !row.journalSeenAt;
  // The journal exports the native store: its first write makes the log native (P3.3).
  const update = firstJournal ? { restore_grade: 'native' as const, ...patch } : patch;
  if (!update && batch.generation === row.generation) return null;
  // A grade without `grade_counts` has none: a converted log's counts must not outlive it.
  const record = update?.restore_grade !== undefined ? sql`(${sessionLogs.record} - 'grade_counts')` : sql`${sessionLogs.record}`;
  await tx
    .update(sessionLogs)
    .set({
      generation: batch.generation,
      ...(firstJournal && { journalSeenAt: sql`now()` }),
      ...(update && { record: capture ? (update as Record<string, unknown>) : sql`${record} || ${JSON.stringify(update)}::jsonb` }),
      ...(update?.v !== undefined && { v: update.v }),
      ...(update?.harness?.current !== undefined && { harnessCurrent: update.harness.current }),
      ...(update?.restore_grade !== undefined && { restoreGrade: update.restore_grade, gradeCounts: update.grade_counts ?? null }),
      updatedAt: sql`now()`,
    })
    .where(eq(sessionLogs.sessionId, scope.sessionId));
  // P3.3: a capture row the journal does not claim stays visible, out of context: the native
  // store is what the model sees. A restored box (generation > 0) holds this log: rows stay as they are.
  if (firstJournal && batch.generation === 0) {
    await tx
      .update(sessionLogMessages)
      .set({ inContext: false, record: sql`jsonb_set(${sessionLogMessages.record}, '{in_context}', 'false')`, updatedAt: sql`now()` })
      .where(and(eq(sessionLogMessages.sessionId, scope.sessionId), lt(sessionLogMessages.rev, SESSION_LOG_CAPTURE_REV_LIMIT), isNull(sessionLogMessages.deletedAt)));
  }
  return null;
}

async function upsertThreads(tx: Tx, sessionId: string, batch: SessionLogJournalRequest): Promise<void> {
  // The last upsert of a thread wins; one statement cannot touch a row twice.
  const threads = [...new Map(batch.threads.map((t) => [t.thread_id, t])).values()];
  if (threads.length === 0) return;
  await tx
    .insert(sessionLogThreads)
    .values(
      threads.map((t) => ({
        sessionId,
        threadId: t.thread_id,
        parentThreadId: t.parent_thread_id,
        v: t.v,
        record: t as unknown as Record<string, unknown>,
      })),
    )
    .onConflictDoUpdate({
      target: [sessionLogThreads.sessionId, sessionLogThreads.threadId],
      set: {
        parentThreadId: sql`excluded.parent_thread_id`,
        v: sql`excluded.v`,
        record: sql`excluded.record`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * A capture row (rev below the limit) that holds the `(thread_id, seq)` a put
 * of this batch claims for another message is provisional: it gives way as a
 * tombstone at seq `-rev`, the capture tombstone's place (capture revs are
 * unique per session, so that seq is free). Never deleted. For a journal put
 * that is the journal taking over a capture's seq. For a capture put it is a
 * shifted message, whose own put in this batch revives it at its new seq.
 */
async function dropProvisionalRows(tx: Tx, sessionId: string, puts: readonly SessionLogPut[]): Promise<void> {
  if (puts.length === 0) return;
  const claims = JSON.stringify(puts.map(({ message: m }) => ({ message_id: m.message_id, thread_id: m.thread_id, seq: m.seq })));
  const dropped = await tx.execute<{ message_id: string; thread_id: string; seq: number }>(sql`
    UPDATE kortix.session_log_messages m
       SET deleted_at = coalesce(m.deleted_at, now()), seq = -m.rev, updated_at = now()
      FROM jsonb_to_recordset(${claims}::jsonb) AS p(message_id text, thread_id text, seq int)
     WHERE m.session_id = ${sessionId} AND m.thread_id = p.thread_id AND m.seq = p.seq
       AND m.message_id <> p.message_id AND m.rev < ${SESSION_LOG_CAPTURE_REV_LIMIT}
    RETURNING m.message_id, m.thread_id, p.seq`);
  if (dropped.length > 0) {
    logger.info('[session-log] provisional capture rows gave up their seq', { sessionId, rows: dropped.slice(0, 20) });
  }
}

/**
 * A pi dump written before P2.5 has no Kortix ids: pi exports its replies as `pi:<entry id>`
 * (`harness/pi/session-log.ts` in kortixd). Its capture rows carry the v1 ids, so they would
 * stay next to the native ones. A journal reply with a `pi:` id tombstones every live capture
 * row of its thread at seq `-rev`. A P2.5+ dump gives every reply a Kortix id; only its
 * system and custom messages have `pi:` ids, so they do not count. Generation 0 only: a
 * restored store (P6.2) holds this log and writes `pi:` replies of its own (a layout compaction).
 */
async function hideConvertedPiThreads(tx: Tx, sessionId: string, puts: readonly SessionLogPut[]): Promise<void> {
  const threads = [...new Set(puts.flatMap(({ message: m }) => (m.role === 'assistant' && m.message_id.startsWith('pi:') ? [m.thread_id] : [])))];
  if (threads.length === 0) return;
  await tx
    .update(sessionLogMessages)
    .set({ deletedAt: sql`now()`, seq: sql`-${sessionLogMessages.rev}`, updatedAt: sql`now()` })
    .where(
      and(
        eq(sessionLogMessages.sessionId, sessionId),
        inArray(sessionLogMessages.threadId, threads),
        lt(sessionLogMessages.rev, SESSION_LOG_CAPTURE_REV_LIMIT),
        isNull(sessionLogMessages.deletedAt),
      ),
    );
}

// ponytail: one INSERT per put, so a seq collision names its own pair without
// parsing the error detail. A batch is at most 1 MB gzipped; batch the inserts
// if a large boot reconcile (P6) makes the round trips show up.
async function applyPut(tx: Tx, sessionId: string, generation: number, put: SessionLogPut, record: SessionLogPut['message']): Promise<void> {
  const m = put.message;
  const createdAt = Date.parse(m.created_at);
  try {
    await tx
      .insert(sessionLogMessages)
      .values({
        sessionId,
        messageId: m.message_id,
        threadId: m.thread_id,
        seq: m.seq,
        role: m.role,
        kind: m.kind,
        inContext: m.in_context,
        // A converted record may carry an empty `created_at`; the record keeps
        // it, the column (an ordering aid) takes the ingest time.
        createdAt: Number.isFinite(createdAt) ? new Date(createdAt) : new Date(),
        v: m.v,
        producer: m.producer,
        generation,
        rev: put.rev,
        contentHash: sessionLogContentHash(m),
        deletedAt: null,
        record: record as unknown as Record<string, unknown>,
        toolInputOrder: toolInputOrderOf(record),
      })
      .onConflictDoUpdate({
        target: [sessionLogMessages.sessionId, sessionLogMessages.messageId],
        set: {
          threadId: sql`excluded.thread_id`,
          seq: sql`excluded.seq`,
          role: sql`excluded.role`,
          kind: sql`excluded.kind`,
          inContext: sql`excluded.in_context`,
          createdAt: sql`excluded.created_at`,
          v: sql`excluded.v`,
          producer: sql`excluded.producer`,
          generation: sql`excluded.generation`,
          rev: sql`excluded.rev`,
          contentHash: sql`excluded.content_hash`,
          deletedAt: null,
          record: sql`excluded.record`,
          toolInputOrder: sql`excluded.tool_input_order`,
          updatedAt: sql`now()`,
        },
        // An unchanged re-put (a restarted daemon re-sends every message) leaves the row; it is still acknowledged.
        // A capture row and a row of another generation are always replaced.
        setWhere: sql`(excluded.generation, excluded.rev) > (${sessionLogMessages.generation}, ${sessionLogMessages.rev})
          AND (${sessionLogMessages.contentHash} IS DISTINCT FROM excluded.content_hash OR ${sessionLogMessages.deletedAt} IS NOT NULL
               OR ${sessionLogMessages.rev} < ${SESSION_LOG_CAPTURE_REV_LIMIT} OR ${sessionLogMessages.generation} <> excluded.generation)`,
      });
  } catch (err) {
    if (uniqueViolationConstraint(err) !== SEQ_KEY) throw err;
    throw new SeqConflict({ error: 'seq_conflict', message_id: m.message_id, rev: put.rev, thread_id: m.thread_id, seq: m.seq });
  }
}

async function markDurableTurns(tx: Tx, sessionId: string, puts: readonly SessionLogPut[]): Promise<void> {
  const done = puts.map((p) => p.message).filter((m) => m.status !== 'streaming');
  const compactions = done.filter((m) => m.kind === 'compaction');
  const userMessageIds = [...new Set(done.flatMap((m) => (m.role === 'assistant' && m.reply_to ? [m.reply_to] : [])))];
  // The first acknowledgement: a daemon that restarts re-sends every message, and a replay is not new durability.
  const durable = { logDurableAt: sql`coalesce(${sessionTurns.logDurableAt}, now())` };
  if (userMessageIds.length > 0) {
    await tx
      .update(sessionTurns)
      .set(durable)
      .where(and(eq(sessionTurns.sessionId, sessionId), inArray(sessionTurns.messageId, userMessageIds)));
  }
  for (const m of compactions) {
    // OpenCode: the `/summarize` turn's message id is the compaction's.
    const byId = await tx
      .update(sessionTurns)
      .set(durable)
      .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.messageId, m.message_id)))
      .returning({ token: sessionTurns.turnToken });
    if (byId.length > 0) continue;
    // pi: the `/summarize` turn has no message id. Also OpenCode: an auto compaction inside a
    // turn whose id bind failed (`bindRootScopedTurn` refuses two open id-less records).
    const completedAt = Date.parse(m.completed_at ?? m.created_at);
    if (Number.isNaN(completedAt)) continue;
    const at = new Date(completedAt);
    // ponytail: started_at/ended_at are the API clock, completed_at the box clock (pi stamps
    // created_at at the end too, so no start time exists). A box behind the API by more than
    // the summary's run time marks nothing. A box ahead can admit a turn that started after
    // the compaction completed, but only when no earlier unmarked id-less turn was still open.
    const earliest = tx
      .select({ token: sessionTurns.turnToken })
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.sessionId, sessionId),
          eq(sessionTurns.runtimeSessionId, m.thread_id),
          isNull(sessionTurns.messageId),
          isNull(sessionTurns.logDurableAt),
          lte(sessionTurns.startedAt, at),
          or(isNull(sessionTurns.endedAt), gte(sessionTurns.endedAt, at)),
        ),
      )
      .orderBy(asc(sessionTurns.startedAt))
      .limit(1);
    await tx.update(sessionTurns).set(durable).where(inArray(sessionTurns.turnToken, earliest));
  }
}

/** The boot-reconcile manifest, or null when the session is not this project's. */
export async function readSessionLogManifest(scope: SessionLogScope): Promise<SessionLogManifest | null> {
  if (!(await sessionExists(scope))) return null;
  const [log] = await db
    .select({ generation: sessionLogs.generation })
    .from(sessionLogs)
    .where(eq(sessionLogs.sessionId, scope.sessionId))
    .limit(1);
  // `rev` through the drizzle column (`bigint`, mode number): a JSON number, never the int8 string raw SQL returns.
  const rows = await db
    .select({
      message_id: sessionLogMessages.messageId,
      content_hash: sessionLogMessages.contentHash,
      rev: sessionLogMessages.rev,
      deletedAt: sessionLogMessages.deletedAt,
    })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, scope.sessionId))
    .orderBy(asc(sessionLogMessages.threadId), asc(sessionLogMessages.seq));
  return {
    generation: log?.generation ?? 0,
    messages: rows.map(({ deletedAt, ...r }) => ({ ...r, deleted: deletedAt !== null })),
  };
}
