/**
 * The backfill of old sessions (P3.1): every session whose history is only in
 * the v1 mirror (`session_transcript_*`) gets its v2 session log, so the read
 * path can later switch to the log for everyone.
 *
 * - One conversion path. Each session goes through the P2.7 capture write
 *   (`writeSessionLogFromMirror`, `session-log-capture.ts`): `fromV1` of the
 *   stored mirror, applied at generation 0 with capture revs, large texts
 *   offloaded, under the session's advisory lock. A session that a journal, a
 *   capture or a restore claim wrote after the selection is skipped there
 *   (`journal_seen_at`, the stored content hashes, the mirror's `captured_at`,
 *   the generation fence).
 * - Selection. A mirror with at least one row, no `session_logs` row, and no
 *   `project_sessions.metadata.deletedAt` (the retention purge removes those:
 *   the backfill never resurrects one). Oldest `created_at` first,
 *   `BACKFILL_BATCH_SIZE` per tick, one session per transaction.
 * - Cursor. Written logs leave the queue, so a write pass resumes after a
 *   restart by itself. Within a pass, the tick also walks a keyset cursor
 *   `(created_at, session_id)` kept in memory: a dry pass writes no row, and a
 *   failed session stays behind the cursor, so a pass visits each session once.
 *   A pass ends on a short batch.
 * - Passes. `write` starts a new pass after each one (the worker waits an hour);
 *   it selects only sessions without a log, so every pass retries the failures
 *   of the last one and is cheap once the queue is empty. `dry` runs one pass per
 *   process: after its summary it does nothing until the process restarts or the
 *   mode changes, because each dry pass reads and converts every old mirror.
 * - Budget. A tick stops after the session that crossed `BACKFILL_BUDGET_MS`.
 * - Logs. One info line of counts per tick that converted anything, one summary
 *   per pass. No session id or content above debug. A `write` pass while
 *   `SESSION_LOG_INGEST_ENABLED` is off skips every session: one warning per pass.
 */
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { largeTextCount } from './session-log-blobs';
import { writeSessionLogFromMirror } from './session-log-capture';

export const BACKFILL_BATCH_SIZE = 50;
export const BACKFILL_BUDGET_MS = 20_000;

export type BackfillMode = 'dry' | 'write';

const zero = () => ({
  /** Sessions the tick took from the queue. */
  sessions: 0,
  /** Logs written (dry: logs that would be written). */
  logs: 0,
  skipped: 0,
  failed: 0,
  messages: 0,
  // Restore grades of the logs. `fromV1` gives converted or partial.
  native: 0,
  converted: 0,
  partial: 0,
  // What the in-context messages lost (`grade_counts`).
  tool_input: 0,
  cut_point: 0,
  attachment: 0,
  /** UTF-8 bytes of the message records, before offload. */
  record_bytes: 0,
  /** Texts over 256 kB that go to an object. */
  offload_texts: 0,
  /** Logs converted as `opencode` because no runtime projection names a harness. */
  harness_defaulted: 0,
  // The worst session: the longest conversion (a write holds the session lock for part of it),
  // the most messages, the most record bytes (both held in memory at once).
  max_session_ms: 0,
  max_session_messages: 0,
  max_session_record_bytes: 0,
  /** Wall time since the pass started. */
  pass_ms: 0,
});
export type BackfillCounts = ReturnType<typeof zero>;
const MAX_KEYS = new Set<keyof BackfillCounts>(['max_session_ms', 'max_session_messages', 'max_session_record_bytes', 'pass_ms']);

export type BackfillState = {
  mode: BackfillMode | null;
  after: { createdAt: string; sessionId: string } | null;
  totals: BackfillCounts;
  passStartedAt: number | null;
  ingestOffWarned: boolean;
  /** A dry pass ended: nothing more until the process restarts or the mode changes. */
  dryDone: boolean;
};

export const newBackfillState = (mode: BackfillMode | null = null): BackfillState => ({
  mode,
  after: null,
  totals: zero(),
  passStartedAt: null,
  ingestOffWarned: false,
  dryDone: false,
});

/** The next sessions to convert: after the cursor, oldest first. */
async function selectBatch(after: BackfillState['after']) {
  // `created_at::text` keeps the microseconds a JS Date would drop, so the cursor never re-selects a row.
  return db.execute<{ session_id: string; created_at: string }>(sql`
    SELECT s.session_id, s.created_at::text AS created_at
      FROM kortix.session_transcript_mirrors m
      JOIN kortix.project_sessions s ON s.session_id = m.session_id
     WHERE s.metadata ->> 'deletedAt' IS NULL
       AND NOT EXISTS (SELECT 1 FROM kortix.session_logs l WHERE l.session_id = m.session_id)
       AND EXISTS (SELECT 1 FROM kortix.session_transcript_messages t WHERE t.session_id = m.session_id)
       ${after ? sql`AND (s.created_at, s.session_id) > (${after.createdAt}::timestamptz, ${after.sessionId})` : sql``}
     ORDER BY s.created_at, s.session_id
     LIMIT ${BACKFILL_BATCH_SIZE}`);
}

async function convertOne(sessionId: string, mode: BackfillMode, convert: typeof writeSessionLogFromMirror, counts: BackfillCounts) {
  counts.sessions++;
  const started = performance.now();
  const result = await convert(sessionId, { dry: mode === 'dry' }).catch((err: unknown) => {
    logger.debug('[session-log] backfill conversion threw', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' as const };
  });
  counts.max_session_ms = Math.max(counts.max_session_ms, Math.round(performance.now() - started));
  if (result.outcome === 'skipped') counts.skipped++;
  if (result.outcome === 'failed') {
    counts.failed++;
    logger.debug('[session-log] backfill session failed', { sessionId, status: 'status' in result ? result.status : undefined });
  }
  if (result.outcome !== 'written' && result.outcome !== 'dry') return;
  const { log, batch } = result;
  counts.logs++;
  counts[log.restore_grade]++;
  if (result.harnessDefaulted) counts.harness_defaulted++;
  for (const k of ['tool_input', 'cut_point', 'attachment'] as const) counts[k] += log.grade_counts?.[k] ?? 0;
  let bytes = 0;
  for (const { message } of batch.puts) {
    bytes += Buffer.byteLength(JSON.stringify(message));
    counts.offload_texts += largeTextCount(message);
  }
  counts.messages += batch.puts.length;
  counts.record_bytes += bytes;
  counts.max_session_messages = Math.max(counts.max_session_messages, batch.puts.length);
  counts.max_session_record_bytes = Math.max(counts.max_session_record_bytes, bytes);
}

/**
 * One tick: up to `BACKFILL_BATCH_SIZE` sessions after the cursor in `state`.
 * `more` is true while the queue may hold more (a full batch, or the budget cut it).
 * When a write pass ends, `state` starts over; when a dry pass ends, every later
 * dry tick does nothing. `convert` is the capture write; tests wrap it.
 */
export async function backfillSessionLogs(
  mode: BackfillMode,
  state: BackfillState,
  options: { budgetMs?: number; convert?: typeof writeSessionLogFromMirror } = {},
): Promise<{ more: boolean; counts: BackfillCounts }> {
  const { budgetMs = BACKFILL_BUDGET_MS, convert = writeSessionLogFromMirror } = options;
  if (state.mode !== mode) Object.assign(state, newBackfillState(mode));
  const counts = zero();
  if (state.dryDone) return { more: false, counts };
  const started = Date.now();
  state.passStartedAt ??= started;
  if (mode === 'write' && !config.SESSION_LOG_INGEST_ENABLED && !state.ingestOffWarned) {
    state.ingestOffWarned = true;
    logger.warn('[session-log] backfill write pass while SESSION_LOG_INGEST_ENABLED=false: every session is skipped');
  }
  const batch = await selectBatch(state.after);
  for (const row of batch) {
    state.after = { createdAt: row.created_at, sessionId: row.session_id };
    await convertOne(row.session_id, mode, convert, counts);
    if (Date.now() - started >= budgetMs) break;
  }
  const more = counts.sessions < batch.length || batch.length === BACKFILL_BATCH_SIZE;
  counts.pass_ms = Date.now() - state.passStartedAt;
  for (const k of Object.keys(counts) as Array<keyof BackfillCounts>) {
    state.totals[k] = MAX_KEYS.has(k) ? Math.max(state.totals[k], counts[k]) : state.totals[k] + counts[k];
  }
  if (counts.sessions > 0) logger.info('[session-log] backfill tick', { mode, ...counts, more, ms: Date.now() - started });
  if (!more) {
    if (state.totals.sessions > 0) logger.info('[session-log] backfill pass complete', { mode, ...state.totals });
    Object.assign(state, newBackfillState(mode), { dryDone: mode === 'dry' });
  }
  return { more, counts };
}
