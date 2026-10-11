/**
 * The session-log journal ingest and manifest (P2.2): what kortixd's journal
 * (`apps/kortix-sandbox-agent-server/src/harness/shared/session-log-journal.ts`)
 * writes into `session_logs`, `session_log_threads` and `session_log_messages`.
 * The wire and its status codes are in `@kortix/api-contract/session-log` (`wire.ts`).
 *
 * One transaction per batch, under a per-session advisory lock:
 * - Generation fence. `session_logs.generation` is the session's generation. A
 *   batch with an older one answers 409 and writes nothing. An equal one is
 *   accepted. A newer one is accepted and becomes the session's (P6 mints them).
 * - Revisions. A put or a tombstone applies only when its (generation, rev) is
 *   above the stored message's. Every pair of the batch is acknowledged, applied
 *   or not, after commit. A higher put revives a tombstoned message.
 * - `seq` is unique per thread (`session_log_messages_thread_seq_key`). A put
 *   that collides rolls the whole batch back and answers 422 with its pair.
 * - Durable turns. The first acknowledged assistant message of a turn that is not
 *   streaming sets `session_turns.log_durable_at`: the turn whose `message_id` (the
 *   client-minted user message id) is the assistant message's `reply_to`. A later
 *   acknowledgement (a restarted daemon re-sends everything) keeps the first time.
 *
 * Records are stored as the daemon sent them, not as zod parsed them: the parse
 * drops fields this API does not know, and the record would lose them (the same
 * rule as `upcast`).
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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { uniqueViolationConstraint } from '../shared/postgres-errors';

export interface SessionLogScope {
  sessionId: string;
  projectId: string;
  accountId: string;
}

export type SessionLogJournalOutcome =
  | { status: 200; body: SessionLogJournalResponse }
  | { status: 404; body: { error: string } }
  | { status: 409; body: SessionLogJournalConflict }
  | { status: 422; body: SessionLogJournalSeqConflict };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SEQ_KEY = 'session_log_messages_thread_seq_key';
const NO_SESSION = { status: 404, body: { error: 'Session not found' } } as const;

class SeqConflict extends Error {
  constructor(readonly body: SessionLogJournalSeqConflict) {
    super('seq_conflict');
  }
}

/** The session row, only when it belongs to this project and account. */
async function sessionExists(scope: SessionLogScope): Promise<boolean> {
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

/** Apply one journal batch. `batch` is the request body as sent, already validated by `SessionLogJournalRequestSchema`. */
export async function ingestSessionLogJournal(
  scope: SessionLogScope,
  batch: SessionLogJournalRequest,
): Promise<SessionLogJournalOutcome> {
  if (!(await sessionExists(scope))) return NO_SESSION;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`session-log:${scope.sessionId}`}))`);
      const current = await upsertSession(tx, scope, batch);
      if (current !== null) return { status: 409 as const, body: { generation: current } };
      await upsertThreads(tx, scope.sessionId, batch);
      for (const put of batch.puts) await applyPut(tx, scope.sessionId, batch.generation, put);
      for (const t of batch.tombstones) {
        await tx
          .update(sessionLogMessages)
          .set({ deletedAt: sql`now()`, rev: t.rev, generation: batch.generation, updatedAt: sql`now()` })
          .where(
            and(
              eq(sessionLogMessages.sessionId, scope.sessionId),
              eq(sessionLogMessages.messageId, t.message_id),
              sql`(${batch.generation}::int, ${t.rev}::bigint) > (${sessionLogMessages.generation}, ${sessionLogMessages.rev})`,
            ),
          );
      }
      await markDurableTurns(tx, scope.sessionId, batch.puts);
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
 * session's generation when the batch's is older (nothing was written), else null.
 */
async function upsertSession(tx: Tx, scope: SessionLogScope, batch: SessionLogJournalRequest): Promise<number | null> {
  const [row] = await tx
    .select({ generation: sessionLogs.generation })
    .from(sessionLogs)
    .where(eq(sessionLogs.sessionId, scope.sessionId))
    .limit(1);
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
    });
    return null;
  }
  if (!patch && batch.generation === row.generation) return null;
  await tx
    .update(sessionLogs)
    .set({
      generation: batch.generation,
      ...(patch && { record: sql`${sessionLogs.record} || ${JSON.stringify(patch)}::jsonb` }),
      ...(patch?.v !== undefined && { v: patch.v }),
      ...(patch?.harness?.current !== undefined && { harnessCurrent: patch.harness.current }),
      ...(patch?.restore_grade !== undefined && { restoreGrade: patch.restore_grade }),
      ...(patch?.grade_counts !== undefined && { gradeCounts: patch.grade_counts }),
      updatedAt: sql`now()`,
    })
    .where(eq(sessionLogs.sessionId, scope.sessionId));
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

// ponytail: one INSERT per put, so a seq collision names its own pair without
// parsing the error detail. A batch is at most 1 MB gzipped; batch the inserts
// if a large boot reconcile (P6) makes the round trips show up.
async function applyPut(tx: Tx, sessionId: string, generation: number, put: SessionLogPut): Promise<void> {
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
        record: m as unknown as Record<string, unknown>,
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
          updatedAt: sql`now()`,
        },
        setWhere: sql`(excluded.generation, excluded.rev) > (${sessionLogMessages.generation}, ${sessionLogMessages.rev})`,
      });
  } catch (err) {
    if (uniqueViolationConstraint(err) !== SEQ_KEY) throw err;
    throw new SeqConflict({ error: 'seq_conflict', message_id: m.message_id, rev: put.rev, thread_id: m.thread_id, seq: m.seq });
  }
}

async function markDurableTurns(tx: Tx, sessionId: string, puts: readonly SessionLogPut[]): Promise<void> {
  const userMessageIds = [
    ...new Set(
      puts.flatMap(({ message: m }) =>
        m.role === 'assistant' && m.status !== 'streaming' && m.reply_to ? [m.reply_to] : [],
      ),
    ),
  ];
  if (userMessageIds.length === 0) return;
  await tx
    .update(sessionTurns)
    // The first acknowledgement: a daemon that restarts re-sends every message, and a replay is not new durability.
    .set({ logDurableAt: sql`coalesce(${sessionTurns.logDurableAt}, now())` })
    .where(and(eq(sessionTurns.sessionId, sessionId), inArray(sessionTurns.messageId, userMessageIds)));
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
