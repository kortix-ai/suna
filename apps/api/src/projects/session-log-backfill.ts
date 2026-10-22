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
 * - Selection. `kortix.mirror_sessions_without_log()` (migration
 *   `20261022130858924_mirror_sessions_without_log.sql`), the one definition the Release B drop
 *   guard reads too: a mirror with at least one row, no `session_logs` row, no purge marker, and
 *   a session that is not deleted or is still restorable (`kortix.session_delete_due_at`, the
 *   retention purge's due time). A restorable deleted session converts now, so its restore
 *   finds its history after the mirror is dropped; the purge deletes its log rows with its
 *   mirror rows. Oldest `created_at` first, `BACKFILL_BATCH_SIZE` per tick, one session per
 *   transaction.
 * - Cursor. The pass state (mode, keyset cursor `(created_at, session_id)`,
 *   running totals) is one row of `kortix.session_log_backfill_state`, loaded
 *   and saved by every tick, so a new leader resumes the pass where the last one
 *   stopped. A dry pass writes no log, and a failed session stays behind the
 *   cursor, so a pass visits each session once. A pass ends on a short batch.
 *   A tick saves only over the `rev` it loaded: an old leader's late tick cannot
 *   move the cursor back. A mode change starts a new pass.
 * - Passes. `write` starts a new pass after each one (the worker waits an hour);
 *   it selects only sessions without a log, so every pass retries the failures
 *   of the last one. A pass that selects nothing sets `drainedWithDeleted`: no read
 *   serves the mirror, nothing writes it (P8.2), and only the purge deletes a log (and
 *   writes the purge marker the selection excludes), so the selection stays empty and every
 *   later tick, in any mode, does nothing and reads no mirror table. From then on no code
 *   path touches a mirror table (`mirrorDrained`, `session-log-capture.ts`; Release B1), so
 *   the Release B2 migration can drop them. The key replaced `drained` (2026-10-22),
 *   which a selection that skipped deleted sessions set. `dry` runs one pass per
 *   build (`KORTIX_COMMIT`): after its summary it does nothing until the mode or
 *   the build changes, because each dry pass reads and converts every old
 *   mirror. A skipped dry tick says so once per process at info. Run it again on
 *   the same build: `DELETE FROM kortix.session_log_backfill_state`.
 * - Size cap (P3.4). A mirror over the capture's cap (`mirrorStoredCap`, `session-log-capture.ts`)
 *   makes the capture answer `too_large` after one cheap size query. The backfill counts it
 *   (`too_large`) and converts it in a Bun `Worker` (`session-log-backfill-thread.ts`): the same
 *   `convertOne`, uncapped, on the thread's own heap, event loop and DB pool. The synchronous
 *   stages (`fromV1`, the schema check, the hashes, `jsonbSafeValue`, the dry round trip) of a
 *   large mirror run for seconds: one 200 MB session held a prod API task's event loop 17 s
 *   (2026-10-16). The thread's counts are added to the tick's; a thread that throws or exits
 *   before it answers counts `failed`. One thread at a time, ended after its session. A restore
 *   of such a log still answers 413 above `SESSION_LOG_RESTORE_MAX_BYTES`.
 * - Thread guards. The leader also serves requests, and ECS kills a task over its memory limit
 *   with every request in flight. Before the thread starts:
 *   - Memory: the thread starts only while RSS plus `THREAD_BYTES_PER_JSON_BYTE` times the
 *     mirror's JSON bytes stays under `THREAD_MEMORY_SHARE` of the limit (cgroup `memory.max`,
 *     capped by `SESSION_LOG_BACKFILL_MEMORY_MB`). Else the session is `deferred` (and
 *     `too_large`), not converted, not failed: a later pass tries again.
 *   - Poison pill: the tick saves the state with the cursor on this session and
 *     `threadStarted` = its id, and clears it when the thread answers. A tick that loads a
 *     `threadStarted` knows its process died during that thread (out of memory, a deploy): the
 *     session counts `failed` (one warning, no id), gets one more `threadCrashes`, and the cursor
 *     is already past it. A session whose thread died `THREAD_ATTEMPTS` times never starts one
 *     again (`failed`). `threadCrashes` outlives the pass and a mode change.
 * - Budget. A tick stops after the session that crossed `BACKFILL_BUDGET_MS`.
 * - Checks. Every converted log is validated with `SessionLogSchema` in the converter: a log
 *   that fails is not written (`validation_failed`). A dry pass also compares, per session,
 *   `toV1(fromV1(rows))` with `rows`, the stored v1 rows as the v1 read serves them (a call the
 *   old mirror stripped carries its proven input, `restoreStrippedToolParts`; the converter
 *   converts those rows), with the P1 round-trip test's equality
 *   (`session-log-v1.test.ts`: parsed JSON, keys sorted, rows as a multiset):
 *   `roundtrip_mismatch_sessions` and `roundtrip_mismatch_messages`. The compare is on the
 *   converted log before the F3 offload; the v1 read rehydrates offloaded texts.
 * - On a read (P8.2). The log reads (`session-log-read.ts`) call `convertMirrorOnRead` for a
 *   session with no log: while the mirror is not drained, the same capped conversion runs
 *   then, so a self-hosted upgrade serves its old sessions before its pass reaches them. A
 *   mirror over the cap throws `SessionLogConvertingError` (`GET …/log` answers 503
 *   `session_log_converting`); this pass's thread converts it. Once drained, a read of a
 *   session with no log (a new session before its first journal batch) reads no mirror table.
 * - Logs. One info line of counts per tick that converted anything, one summary
 *   per pass. No session id or content above debug. A `write` pass while
 *   `SESSION_LOG_INGEST_ENABLED` is off skips every session: one warning per pass.
 */
import { readFileSync } from 'node:fs';
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

export const zero = () => ({
  /** Sessions the tick took from the queue. */
  sessions: 0,
  /** Of `sessions`: deleted sessions still inside the restore window. */
  deleted: 0,
  /** Logs written (dry: logs that would be written). */
  logs: 0,
  skipped: 0,
  failed: 0,
  /** Sessions whose mirror is over the capture's size cap (`mirrorStoredCap`): converted in a thread. */
  too_large: 0,
  /** Of `too_large`: not converted, the thread had no room under the memory limit. A later pass tries again. */
  deferred: 0,
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
  /** The session whose conversion thread started and has not answered. */
  threadStarted: string | null;
  /** Per session: threads that never answered, because their process died. Kept across passes. */
  threadCrashes: Record<string, number>;
  /** A pass selected no session: no session, restorable deleted ones included, has mirror rows and no log. Kept across passes and modes. */
  drainedWithDeleted: boolean;
};

export const newBackfillState = (mode: BackfillMode | null = null): BackfillState => ({
  mode,
  after: null,
  totals: zero(),
  passStartedAt: null,
  ingestOffWarned: false,
  dryDone: false,
  threadStarted: null,
  threadCrashes: {},
  drainedWithDeleted: false,
});

/** A new pass in `state`: everything but `threadCrashes` and `drainedWithDeleted` starts over. */
const restart = (state: BackfillState, mode: BackfillMode, extra: Partial<BackfillState> = {}) =>
  Object.assign(state, newBackfillState(mode), { threadCrashes: state.threadCrashes, drainedWithDeleted: state.drainedWithDeleted }, extra);

/** Thread attempts per session: a thread that kills its process twice never starts again. */
export const THREAD_ATTEMPTS = 2;
/**
 * The thread's peak memory per byte of the mirror's JSON, rounded up: 11.3 measured with `smol`
 * (1-vCPU Linux container, 131 MB of JSON, ~1.48 GB peak above the process).
 */
const THREAD_BYTES_PER_JSON_BYTE = 12;
/** The share of the memory limit RSS plus the thread's estimate must stay under. */
const THREAD_MEMORY_SHARE = 0.75;

/** The process's memory limit in bytes: cgroup v2 `memory.max` when set, capped by `SESSION_LOG_BACKFILL_MEMORY_MB`. */
function memoryLimit(): number {
  const configured = config.SESSION_LOG_BACKFILL_MEMORY_MB * 1024 * 1024;
  try {
    const max = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (/^\d+$/.test(max)) return Math.min(Number(max), configured);
  } catch {
    // No cgroup v2 file (macOS, cgroup v1): the configured limit.
  }
  return configured;
}

/** Room for `sessionId`'s conversion thread: RSS plus its estimate under `THREAD_MEMORY_SHARE` of the limit. */
async function threadFits(sessionId: string): Promise<boolean> {
  // Postgres detoasts the mirror for the length (~200 ms on 180 MB), off this event loop.
  const [row] = await db.execute<{ bytes: string }>(sql`
    SELECT coalesce(sum(octet_length(info::text) + coalesce(octet_length(parts::text), 0)), 0)::bigint AS bytes
      FROM kortix.session_transcript_messages WHERE session_id = ${sessionId}`);
  const need = Number(row?.bytes ?? 0) * THREAD_BYTES_PER_JSON_BYTE;
  return process.memoryUsage().rss + need <= THREAD_MEMORY_SHARE * memoryLimit();
}

const STATE_ID = 'pass';
/** The build this process last said "dry pass already complete" for: once per build. */
let dryDoneSaidFor: string | null = null;

/** The pass state and the `rev` it was saved at (0: no row yet). */
async function loadState(): Promise<{ state: BackfillState; rev: number }> {
  const [row] = await db.select({ state: sessionLogBackfillState.state, rev: sessionLogBackfillState.rev }).from(sessionLogBackfillState).where(eq(sessionLogBackfillState.id, STATE_ID));
  if (!row) return { state: newBackfillState(), rev: 0 };
  const stored = row.state as BackfillState;
  // A count or a field added since the row was saved starts at its default.
  return { state: { ...newBackfillState(), ...stored, totals: { ...zero(), ...stored.totals }, threadCrashes: { ...stored.threadCrashes } }, rev: row.rev };
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

/** A read found a mirror over the capture's size cap and no log: the backfill's thread converts it. */
export class SessionLogConvertingError extends Error {
  readonly code = 'session_log_converting';
  constructor() {
    super('This session\'s saved history is being converted; try again in a minute');
    this.name = 'SessionLogConvertingError';
  }
}

/**
 * Before a log read answers "no log" (P8.2): convert the session's v1 mirror now, capped, unless
 * the mirror is drained (`mirrorDrained`, checked in the conversion). True when a log was written,
 * so the read reads again. Throws `SessionLogConvertingError` for a mirror over the cap.
 */
export async function convertMirrorOnRead(sessionId: string): Promise<boolean> {
  const result = await writeSessionLogFromMirror(sessionId);
  if (result.outcome === 'too_large') throw new SessionLogConvertingError();
  return result.outcome === 'written';
}

/** The next sessions to convert: after the cursor, oldest first. */
async function selectBatch(after: BackfillState['after']) {
  // `created_at::text` keeps the microseconds a JS Date would drop, so the cursor never re-selects a row.
  return db.execute<{ session_id: string; created_at: string; deleted: boolean }>(sql`
    SELECT q.session_id, q.created_at::text AS created_at, q.deleted
      FROM kortix.mirror_sessions_without_log() q
     ${after ? sql`WHERE (q.created_at, q.session_id) > (${after.createdAt}::timestamptz, ${after.sessionId})` : sql``}
     ORDER BY q.created_at, q.session_id
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

/** Add `from` into `into`: sums, and the max of the max keys. */
function addCounts(into: BackfillCounts, from: BackfillCounts) {
  for (const k of Object.keys(into) as Array<keyof BackfillCounts>) into[k] = MAX_KEYS.has(k) ? Math.max(into[k], from[k]) : into[k] + from[k];
}

/**
 * `convertOne` of one session over the cap, uncapped, in a Bun `Worker`; its counts.
 * ponytail: the thread holds the whole mirror (1-vCPU Linux, 131 MB of JSON: ~1.4 GB peak with `smol`);
 * page the read and write if a session outgrows the API task's memory.
 */
function convertInThread(sessionId: string, mode: BackfillMode): Promise<BackfillCounts> {
  const worker = new Worker(new URL('./session-log-backfill-thread.ts', import.meta.url).href, { smol: true });
  return new Promise<BackfillCounts>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<BackfillCounts>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message));
    // A thread that exits before it answers.
    worker.addEventListener('close', () => reject(new Error('the conversion thread exited')));
    worker.postMessage({ sessionId, mode });
  }).finally(() => worker.terminate());
}

/** `inThread`: converts a session over the cap (`convertInThread` behind the guards); without it, the session is only counted. */
export async function convertOne(
  sessionId: string,
  mode: BackfillMode,
  convert: typeof writeSessionLogFromMirror,
  counts: BackfillCounts,
  inThread?: (sessionId: string) => Promise<BackfillCounts>,
) {
  counts.sessions++;
  const started = performance.now();
  const result = await convert(sessionId, { dry: mode === 'dry' }).catch((err: unknown) => {
    logger.debug('[session-log] backfill conversion threw', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' as const };
  });
  if (result.outcome === 'too_large') {
    counts.too_large++;
    // This session is already counted.
    if (inThread) addCounts(counts, { ...(await inThread(sessionId)), sessions: 0 });
  }
  counts.max_session_ms = Math.max(counts.max_session_ms, Math.round(performance.now() - started));
  if (result.outcome === 'skipped') counts.skipped++;
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
  const loaded = options.state ? { state: options.state, rev: 0 } : await loadState();
  const { state } = loaded;
  let rev = loaded.rev;
  const counts = zero();
  // The poison pill: a thread that never answered took its process down after the row was saved.
  if (state.threadStarted) {
    const crashed = state.threadStarted;
    state.threadStarted = null;
    state.threadCrashes[crashed] = (state.threadCrashes[crashed] ?? 0) + 1;
    counts.failed++;
    logger.warn('[session-log] backfill conversion thread ended with its process; its session counts failed', { attempts: state.threadCrashes[crashed], max_attempts: THREAD_ATTEMPTS });
    logger.debug('[session-log] backfill conversion thread ended with its process', { sessionId: crashed });
  }
  // Nothing left to convert, in any mode: no mirror table is read.
  if (state.drainedWithDeleted) return { more: false, counts };
  // A new mode, or a dry pass that an older build ended, starts a new pass.
  if (state.mode !== mode || (state.dryDone && state.dryCommit !== config.KORTIX_COMMIT)) restart(state, mode);
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
  // Every save writes the pass totals so far: the loaded totals plus this tick's counts.
  const base = state.totals;
  const save = async () => {
    state.totals = { ...base };
    addCounts(state.totals, counts);
    if (options.state) return true;
    const saved = await saveState(state, rev);
    if (saved) rev++;
    return saved;
  };
  const inThread = async (sessionId: string): Promise<BackfillCounts> => {
    const one = { ...zero(), sessions: 1 };
    if ((state.threadCrashes[sessionId] ?? 0) >= THREAD_ATTEMPTS) {
      logger.debug('[session-log] backfill session whose thread ended its process too often; not started', { sessionId });
      return { ...one, failed: 1 };
    }
    if (!(await threadFits(sessionId))) {
      logger.debug('[session-log] backfill session deferred: no memory for its thread', { sessionId });
      return { ...one, deferred: 1 };
    }
    // Saved with the cursor on this session before the thread starts: a process the thread kills leaves the id behind.
    state.threadStarted = sessionId;
    if (!(await save())) {
      state.threadStarted = null;
      return { ...one, failed: 1 };
    }
    const result = await convertInThread(sessionId, mode).catch((err: unknown) => {
      logger.debug('[session-log] backfill conversion thread failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
      return { ...one, failed: 1 };
    });
    state.threadStarted = null;
    await save();
    return result;
  };
  const batch = await selectBatch(state.after);
  for (const row of batch) {
    state.after = { createdAt: row.created_at, sessionId: row.session_id };
    if (row.deleted) counts.deleted++;
    await convertOne(row.session_id, mode, convert, counts, inThread);
    if (Date.now() - started >= budgetMs) break;
  }
  const more = counts.sessions < batch.length || batch.length === BACKFILL_BATCH_SIZE;
  counts.pass_ms = Date.now() - state.passStartedAt;
  state.totals = { ...base };
  addCounts(state.totals, counts);
  if (counts.sessions > 0) logger.info('[session-log] backfill tick', { mode, ...counts, more, ms: Date.now() - started });
  const summary = !more && state.totals.sessions > 0 ? { mode, ...state.totals } : null;
  // A whole pass that selected no session: the mirror holds nothing to convert.
  const drained = !more && state.totals.sessions === 0;
  if (!more) restart(state, mode, mode === 'dry' ? { dryDone: true, dryCommit: config.KORTIX_COMMIT, drainedWithDeleted: drained } : { drainedWithDeleted: drained });
  if (!options.state && !(await saveState(state, rev))) logger.warn('[session-log] backfill state changed under this tick; its cursor is not saved', { mode });
  else if (summary) logger.info('[session-log] backfill pass complete', summary);
  else if (drained && !options.state) logger.info('[session-log] backfill: the v1 mirror holds no session without a log; the backfill stops');
  return { more, counts };
}
