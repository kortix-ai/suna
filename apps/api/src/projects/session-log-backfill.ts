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
 * - Cursor. The pass state (mode, keyset cursor `(created_at, session_id)`,
 *   running totals) is one row of `kortix.session_log_backfill_state`, loaded
 *   and saved by every tick, so a new leader resumes the pass where the last one
 *   stopped. A dry pass writes no log, and a failed session stays behind the
 *   cursor, so a pass visits each session once. A pass ends on a short batch.
 *   A tick saves only over the `rev` it loaded: an old leader's late tick cannot
 *   move the cursor back. A mode change starts a new pass.
 * - Passes. `write` starts a new pass after each one (the worker waits an hour);
 *   it selects only sessions without a log, so every pass retries the failures
 *   of the last one and is cheap once the queue is empty. `dry` runs one pass per
 *   build (`KORTIX_COMMIT`): after its summary it does nothing until the mode or
 *   the build changes, because each dry pass reads and converts every old
 *   mirror. A skipped dry tick says so once per process at info. Run it again on
 *   the same build: `DELETE FROM kortix.session_log_backfill_state`.
 * - Size cap. A mirror over the capture's cap (`mirrorStoredCap`,
 *   `session-log-capture.ts`) is not converted: the capture answers `too_large`
 *   after one cheap size query, and the backfill counts it. Every write pass
 *   counts it again; its v1 mirror stays the store.
 * - Budget. A tick stops after the session that crossed `BACKFILL_BUDGET_MS`.
 * - Checks. Every converted log is validated with `SessionLogSchema` in the converter: a log
 *   that fails is not written (`validation_failed`). A dry pass also compares, per session,
 *   `toV1(fromV1(rows))` with the stored v1 rows, with the P1 round-trip test's equality
 *   (`session-log-v1.test.ts`: parsed JSON, keys sorted, rows as a multiset):
 *   `roundtrip_mismatch_sessions` and `roundtrip_mismatch_messages`. The compare is on the
 *   converted log before the F3 offload; the v1 read rehydrates offloaded texts.
 * - Logs. One info line of counts per tick that converted anything, one summary
 *   per pass. No session id or content above debug. A `write` pass while
 *   `SESSION_LOG_INGEST_ENABLED` is off skips every session: one warning per pass.
 */
import { toV1, type SessionLog, type V1Row } from '@kortix/api-contract/session-log';
import { sessionLogBackfillState } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { largeTextCount } from './session-log-blobs';
import { breathe, writeSessionLogFromMirror } from './session-log-capture';

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
  /** Sessions whose mirror is over the capture's size cap (`mirrorStoredCap`): not converted. */
  too_large: 0,
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
  /** Logs converted as `opencode` because no runtime projection names a harness and the root is not pi-minted. */
  harness_defaulted: 0,
  /** Logs converted as `pi` because no runtime projection names a harness and the mirror's root is pi-minted (`ses_pi…`). */
  harness_inferred_pi: 0,
  /** Sessions whose converted log fails `SessionLogSchema`: never written. */
  validation_failed: 0,
  // Dry only: sessions, and stored v1 rows, that `toV1(fromV1(rows))` does not give back exactly.
  roundtrip_mismatch_sessions: 0,
  roundtrip_mismatch_messages: 0,
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
  /** A dry pass ended: nothing more until the mode or the build changes. */
  dryDone: boolean;
  /** The build (`KORTIX_COMMIT`) that ended the dry pass. */
  dryCommit?: string;
};

export const newBackfillState = (mode: BackfillMode | null = null): BackfillState => ({
  mode,
  after: null,
  totals: zero(),
  passStartedAt: null,
  ingestOffWarned: false,
  dryDone: false,
});

const STATE_ID = 'pass';
/** The build this process last said "dry pass already complete" for: once per build. */
let dryDoneSaidFor: string | null = null;

/** The pass state and the `rev` it was saved at (0: no row yet). */
async function loadState(): Promise<{ state: BackfillState; rev: number }> {
  const [row] = await db.select({ state: sessionLogBackfillState.state, rev: sessionLogBackfillState.rev }).from(sessionLogBackfillState).where(eq(sessionLogBackfillState.id, STATE_ID));
  if (!row) return { state: newBackfillState(), rev: 0 };
  const stored = row.state as BackfillState;
  // A count added since the row was saved starts at 0.
  return { state: { ...newBackfillState(), ...stored, totals: { ...zero(), ...stored.totals } }, rev: row.rev };
}

/** Save over `rev` only. False: another tick saved since this one loaded (an old leader's late tick). */
async function saveState(state: BackfillState, rev: number): Promise<boolean> {
  const saved = await db
    .insert(sessionLogBackfillState)
    .values({ id: STATE_ID, state, rev: rev + 1 })
    .onConflictDoUpdate({ target: sessionLogBackfillState.id, set: { state, rev: rev + 1, updatedAt: sql`now()` }, setWhere: eq(sessionLogBackfillState.rev, rev) })
    .returning({ id: sessionLogBackfillState.id });
  return saved.length > 0;
}

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

/** Canonical JSON: keys sorted at every level, as the P1 round-trip test compares. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** How many stored v1 rows `toV1` of the log does not give back exactly (rows compared as a multiset; an extra row counts too). */
export async function roundTripMismatches(log: SessionLog, rows: V1Row[]): Promise<number> {
  const back = new Map<string, number>();
  const v1 = toV1(JSON.parse(JSON.stringify(log)));
  await breathe();
  for (const k of v1.rows.map(canon)) back.set(k, (back.get(k) ?? 0) + 1);
  await breathe();
  let missing = 0;
  for (const r of rows) {
    const k = canon(r);
    const n = back.get(k) ?? 0;
    if (n > 0) back.set(k, n - 1);
    else missing++;
  }
  let extra = 0;
  for (const n of back.values()) extra += n;
  return Math.max(missing, extra);
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
  if (result.outcome === 'too_large') {
    counts.too_large++;
    logger.debug('[session-log] backfill session over the size cap; not converted', { sessionId });
  }
  if (result.outcome === 'invalid') {
    counts.validation_failed++;
    logger.debug('[session-log] backfill session fails SessionLogSchema', { sessionId });
  }
  if (result.outcome === 'failed') {
    counts.failed++;
    logger.debug('[session-log] backfill session failed', { sessionId, status: 'status' in result ? result.status : undefined });
  }
  if (result.outcome !== 'written' && result.outcome !== 'dry') return;
  const { log, batch } = result;
  counts.logs++;
  counts[log.restore_grade]++;
  if (result.harnessFrom === 'default') counts.harness_defaulted++;
  if (result.harnessFrom === 'root') counts.harness_inferred_pi++;
  if (mode === 'dry') {
    const mismatches = await roundTripMismatches(log, result.rows);
    if (mismatches > 0) {
      counts.roundtrip_mismatch_sessions++;
      counts.roundtrip_mismatch_messages += mismatches;
      logger.debug('[session-log] backfill round trip differs from the mirror', { sessionId, rows: mismatches });
    }
  }
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
 * One tick: up to `BACKFILL_BATCH_SIZE` sessions after the stored cursor.
 * `more` is true while the queue may hold more (a full batch, or the budget cut it).
 * When a write pass ends, the state starts over; when a dry pass ends, every later
 * dry tick does nothing. `convert` is the capture write; tests wrap it.
 * `state` is caller-owned for the operator dry pass: never loaded or saved.
 */
export async function backfillSessionLogs(
  mode: BackfillMode,
  options: { budgetMs?: number; convert?: typeof writeSessionLogFromMirror; state?: BackfillState } = {},
): Promise<{ more: boolean; counts: BackfillCounts }> {
  const { budgetMs = BACKFILL_BUDGET_MS, convert = writeSessionLogFromMirror } = options;
  // The operator owns an ephemeral pass; background ticks keep their durable cursor.
  const { state, rev } = options.state ? { state: options.state, rev: 0 } : await loadState();
  // A new mode, or a dry pass that an older build ended, starts a new pass.
  if (state.mode !== mode || (state.dryDone && state.dryCommit !== config.KORTIX_COMMIT)) Object.assign(state, newBackfillState(mode));
  const counts = zero();
  if (state.dryDone) {
    if (dryDoneSaidFor !== config.KORTIX_COMMIT) {
      dryDoneSaidFor = config.KORTIX_COMMIT;
      logger.info('[session-log] backfill dry pass already complete for this build; to run it again, deploy a new build or DELETE FROM kortix.session_log_backfill_state', { commit: config.KORTIX_COMMIT });
    }
    return { more: false, counts };
  }
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
  const summary = !more && state.totals.sessions > 0 ? { mode, ...state.totals } : null;
  if (!more) Object.assign(state, newBackfillState(mode), mode === 'dry' ? { dryDone: true, dryCommit: config.KORTIX_COMMIT } : {});
  if (!options.state && !(await saveState(state, rev))) logger.warn('[session-log] backfill state changed under this tick; its cursor is not saved', { mode });
  else if (summary) logger.info('[session-log] backfill pass complete', summary);
  return { more, counts };
}
