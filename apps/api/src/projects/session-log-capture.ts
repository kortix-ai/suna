/**
 * Three writers of the session log for what no journal wrote.
 *
 * - `writeSessionLogFromMirror` converts a session's v1 mirror (`session_transcript_*`, written
 *   until P8) into the log. Since P8.2 nothing writes the mirror and no read serves it; this is
 *   the only reader left, and only these call it, each before it reads the log: the backfill
 *   (`session-log-backfill.ts` and its thread), a log read of a session with no log
 *   (`convertMirrorOnRead`), a restore (`restore-session.ts`), a lost-session recovery
 *   (`recover-lost-session.ts`) and a fork (`session-create.ts`). It converts only into a log
 *   with no message yet: a session whose log holds a message never reads the mirror here. Once
 *   the mirror is drained (`mirrorDrained`) it reads no mirror table at all and answers `skipped`.
 * - `mergeMirrorIntoLog` writes into an existing log the mirror messages whose content it lacks
 *   (Release B prerequisite): the backfill's merge pass, after the mirror-only sessions converted.
 * - `writeSessionLogFromRead` is the capture of a box without a journal
 *   (`lib/session-transcript-capture.ts`): the box read goes straight into the log.
 *
 * - "Without a journal" is `session_logs.journal_seen_at` null: an old daemon,
 *   a daemon in `KORTIX_SESSION_LOG_DUMP_DIR` mode, or one whose posts have not
 *   committed yet. Checked once before the read and again under the lock.
 * - Records are `fromV1` of the mirror rows as the v1 read serves them (a call the old
 *   mirror stripped gets back its proven input: `writeConverted`): thread, message and block ids
 *   (block id = part id), seq, residuals and the `kortix.transcript.v1` ext are
 *   exactly what `fromV1` gives. `harness` is the one the daemon reported in its
 *   runtime projection (`session_runtime_projections.harness`); else `pi` when the
 *   mirror's root runtime id is pi-minted (`ses_pi` + 24 hex, `mintRootId` in kortixd
 *   `harness/pi/message-id.ts`; an OpenCode id is `ses_` + 12 hex clock chars, so it
 *   never starts with `ses_pi`); else `opencode`.
 * - The log must pass `SessionLogSchema`. One that does not is not written (`invalid`).
 * - Only a message whose `content_hash` changed is written, at the next capture
 *   rev (1, 2, ... below `SESSION_LOG_CAPTURE_REV_LIMIT`). A stored message that
 *   `fromV1` no longer gives (the mirror removes rows only on a recorded rewind)
 *   gets a tombstone at the next rev. Nothing is ever deleted here.
 * - A write between the read and this write makes it stale: `current` compares
 *   the mirror's `captured_at` and the stored messages under the lock, and the
 *   write is skipped.
 * - The operator switch `SESSION_LOG_INGEST_ENABLED` gates this writer too.
 * - Size cap. The conversion is synchronous and holds the whole mirror in memory:
 *   one 200 MB session blocked a prod API task's event loop 17 s (2026-10-16).
 *   A session without a log whose mirror stores more than `mirrorStoredCap()`
 *   bytes (`pg_column_size`, read without detoasting) gets no log (`too_large`);
 *   a restore answers 413 above `SESSION_LOG_RESTORE_MAX_BYTES` anyway. The
 *   stages yield to the event loop (`breathe`). The backfill converts a session over
 *   the cap in a Bun `Worker` (`uncapped`, `session-log-backfill.ts`); no request does.
 *
 * Never throws: a failed write is a log line and an outcome. The outcome is what
 * the backfill of old sessions (P3.1, `session-log-backfill.ts`) counts. `dry`
 * stops before the write and returns the batch it would write.
 */
import {
  fromV1,
  SessionLogSchema,
  toV1,
  type SessionLog,
  type SessionLogJournalRequest,
  type SessionLogMessage,
  type SessionLogThread,
  type V1Row,
} from '@kortix/api-contract/session-log';
import {
  projectSessions,
  sessionLogMessages,
  sessionLogs,
  sessionLogThreads,
  sessionLogBackfillState,
  sessionRuntimeProjections,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { jsonbSafeValue } from '../shared/jsonb-safe';
import { threadRoom } from './lib/thread-memory';
import { restoreStrippedToolParts } from './lib/session-transcript-mirror';
import { offloadLargeTexts } from './session-log-blobs';
import { applyPut, SESSION_LOG_CAPTURE_REV_LIMIT, sessionLogContentHash, writeCapturedSessionLog } from './session-log-ingest';

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * - `skipped`: the switch is off, the mirror is drained, a journal owns the log, there is no mirror, nothing changed,
 *   a newer mirror capture ran, or the capture revs are exhausted.
 * - `invalid`: `fromV1` of the mirror fails `SessionLogSchema`; nothing written.
 * - `too_large`: no log yet, and the mirror is over the size cap; nothing read or written.
 * - `written`, or `dry` (nothing written): `log` is `fromV1` of `rows` (the mirror rows as the v1 read serves them), `batch` what was (would be) written.
 *   `harnessFrom`: `projection`, `root` (no projection harness, a pi-minted root: `pi`), or `default` (`opencode`).
 * - `failed`: the apply path refused the batch (`status`), or something threw.
 */
export type MirrorLogWrite =
  | { outcome: 'skipped' | 'invalid' | 'too_large' }
  | { outcome: 'written' | 'dry'; log: SessionLog; rows: V1Row[]; batch: SessionLogJournalRequest; harnessFrom: 'projection' | 'root' | 'default' }
  | { outcome: 'failed'; status?: number };

const SKIPPED = { outcome: 'skipped' } as const;
const TOO_LARGE = { outcome: 'too_large' } as const;

/**
 * Stored JSON is about 2x its `pg_column_size` (pglz; 1.3x to 5x measured on local sessions, median
 * 2.0), so this cap is about `SESSION_LOG_RESTORE_MAX_BYTES` of JSON.
 * ponytail: a fixed ratio; a session that compresses 5x passes at up to ~2.5x the restore cap.
 * Measure the stored JSON exactly (`octet_length(info::text)`, 200 ms on 180 MB) if that matters.
 */
export const mirrorStoredCap = () => Math.floor(config.SESSION_LOG_RESTORE_MAX_BYTES / 2);

/**
 * Let timers and I/O run. The conversion of a whole mirror is synchronous: one step per stage
 * keeps the API task's event loop (requests, the leader lease renew) moving on a large session.
 */
export const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The v1 mirror is drained: a backfill pass selected no session (`drainedWithDeleted` in the pass
 * state, `session-log-backfill.ts`), and a merge pass after it found no mirror message whose content
 * the log lacks (`mergedMissing`, `mergeMirrorIntoLog`). Nothing writes the mirror since P8.2, so it
 * stays drained. While the merge is pending this answers false and every path below reads the
 * mirror as it did before Release B1.
 * Every code path that would touch `session_transcript_*` asks this first and touches neither table
 * when it is true (Release B1): the conversion here, the `/log` read, the retention purge and the
 * project transfer. So the Release B2 migration can drop both tables under the code that is live then.
 * One primary-key read of the one-row state table; no mirror table.
 * ponytail: not memoized: a flow fixture and the operator (`DELETE` of the state row) reopen the
 * mirror on a running API, and a cached `true` would hide that. Every caller is a path that would
 * otherwise read the mirror.
 */
export async function mirrorDrained(): Promise<boolean> {
  const [row] = await db
    .select({ drained: sql<boolean | null>`(${sessionLogBackfillState.state} ->> 'drainedWithDeleted')::boolean AND (${sessionLogBackfillState.state} ->> 'mergedMissing')::boolean` })
    .from(sessionLogBackfillState)
    .where(eq(sessionLogBackfillState.id, 'pass'));
  return row?.drained === true;
}

/** `uncapped`: no size cap. Only the backfill's conversion thread passes it (`session-log-backfill-thread.ts`). */
export async function writeSessionLogFromMirror(sessionId: string, options: { dry?: boolean; uncapped?: boolean } = {}): Promise<MirrorLogWrite> {
  try {
    if (!options.dry && !config.SESSION_LOG_INGEST_ENABLED) return SKIPPED;
    // Drained: no mirror table is read (Release B1).
    if (await mirrorDrained()) return SKIPPED;
    const read = await db.transaction(async (tx) => {
      const [s] = await tx
        .select({
          projectId: projectSessions.projectId,
          accountId: projectSessions.accountId,
          journalSeenAt: sessionLogs.journalSeenAt,
          hasLog: sessionLogs.sessionId,
          harness: sessionRuntimeProjections.harness,
        })
        .from(projectSessions)
        .leftJoin(sessionLogs, eq(sessionLogs.sessionId, projectSessions.sessionId))
        .leftJoin(sessionRuntimeProjections, eq(sessionRuntimeProjections.sessionId, projectSessions.sessionId))
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      // A journal owns the log.
      if (!s || s.journalSeenAt) return null;
      const stored = await storedMessages(tx, sessionId);
      // A mirror converts only into a log with no message yet, and is not read otherwise.
      if (stored.length > 0) return null;
      const [mirror] = await tx
        .select({ root: sessionTranscriptMirrors.runtimeSessionId, capturedAt: sessionTranscriptMirrors.capturedAt })
        .from(sessionTranscriptMirrors)
        .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
        .limit(1);
      // No mirror to convert.
      if (!mirror) return null;
      if (!s.hasLog && !options.uncapped) {
        const [size] = await tx.execute<{ bytes: string }>(sql`
          SELECT coalesce(sum(pg_column_size(info) + coalesce(pg_column_size(parts), 0)), 0)::bigint AS bytes
            FROM kortix.session_transcript_messages WHERE session_id = ${sessionId}`);
        if (Number(size?.bytes ?? 0) > mirrorStoredCap()) return TOO_LARGE;
      }
      // ponytail: the whole mirror in memory, under the size cap; the backfill's thread takes the rest.
      const rows = await tx
        .select({ runtime_session_id: sessionTranscriptMessages.runtimeSessionId, info: sessionTranscriptMessages.info, parts: sessionTranscriptMessages.parts })
        .from(sessionTranscriptMessages)
        .where(eq(sessionTranscriptMessages.sessionId, sessionId));
      return { s: { ...s, root: mirror.root }, capturedAt: mirror.capturedAt, rows: rows as unknown as V1Row[], stored };
    }, READ_ONLY);
    if (!read) return SKIPPED;
    if ('outcome' in read) return read;
    const capturedAt = new Date(read.capturedAt).getTime();
    return await writeConverted(sessionId, read.s, read.rows, read.stored, {
      dry: options.dry,
      current: async (tx) => {
        const [mirror] = await tx
          .select({ capturedAt: sessionTranscriptMirrors.capturedAt })
          .from(sessionTranscriptMirrors)
          .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
          .limit(1);
        if (!mirror || new Date(mirror.capturedAt).getTime() !== capturedAt) return false;
        return (await storedMessages(tx, sessionId)).length === 0;
      },
    });
  } catch (err) {
    logger.warn('[session-log] capture write failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' };
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type StoredMessage = { id: string; rev: number; hash: string; deletedAt: Date | null };

const storedMessages = (tx: Tx, sessionId: string): Promise<StoredMessage[]> =>
  tx
    .select({ id: sessionLogMessages.messageId, rev: sessionLogMessages.rev, hash: sessionLogMessages.contentHash, deletedAt: sessionLogMessages.deletedAt })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, sessionId));

const maxCaptureRev = (stored: StoredMessage[]) =>
  stored.reduce((max, r) => (r.rev < SESSION_LOG_CAPTURE_REV_LIMIT ? Math.max(max, r.rev) : max), 0);

/**
 * The log as the capture of a box without a journal reads it before the box (P8): `rows` is `toV1`
 * of its live messages (exact: `fromV1` wrote them, a journal never did), `root_id` its v1 root, `stored` every message's
 * rev and hash. A text over 256 kB is its stored preview here (F3); `writeSessionLogFromRead` never
 * puts a message it did not read from the box, so a preview is never written back.
 */
export async function readCapturedSessionLog(sessionId: string): Promise<{ rows: V1Row[]; root_id: string | null; stored: StoredMessage[] }> {
  return db.transaction(async (tx) => {
    const [log] = await tx.select({ record: sessionLogs.record }).from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId));
    if (!log) return { rows: [], root_id: null, stored: [] };
    const threads = await tx
      .select({ threadId: sessionLogThreads.threadId, record: sessionLogThreads.record })
      .from(sessionLogThreads)
      .where(eq(sessionLogThreads.sessionId, sessionId));
    const messages = await tx
      .select({ threadId: sessionLogMessages.threadId, record: sessionLogMessages.record })
      .from(sessionLogMessages)
      .where(and(eq(sessionLogMessages.sessionId, sessionId), isNull(sessionLogMessages.deletedAt)));
    const stored = await storedMessages(tx, sessionId);
    const log1 = {
      ...log.record,
      session_id: sessionId,
      threads: threads.map((t) => ({ ...t.record, messages: messages.filter((m) => m.threadId === t.threadId).map((m) => m.record) })),
    } as unknown as SessionLog;
    await breathe();
    const v1 = toV1(log1);
    return { rows: v1.rows, root_id: v1.root_id, stored };
  }, READ_ONLY);
}

const idOf = (row: V1Row) => String((row.info as { id?: unknown } | null)?.id ?? '');

/**
 * The capture of a box without a journal (P8): `rows` (the box's messages just
 * read, root and complete sub-agents) go straight into the log; no v1 row is read or written.
 *
 * - Merge, never trim, as the mirror did: `fromV1` runs over the stored log (`before`, from
 *   `readCapturedSessionLog`) with each message the box answered replacing its stored copy, so seqs
 *   and threads stay those of the whole history. Only a message the box answered is put.
 * - Rewind: an OpenCode rewind removes the newest messages from the box and keeps the root. A
 *   `complete` read of the root that lacks a suffix of the stored root messages AND lists a newer
 *   one is that shape: the lacking messages are tombstoned (soft: the row and record stay, a later
 *   put of the same id revives it) and leave the merge, so the seqs after them close up. Nothing
 *   else is tombstoned: an empty, partial or tail read, a read that lacks only the newest
 *   messages, a hole (an older message gone, a newer one kept), a sub-agent's rows, and a pi box
 *   (pi has no rewind) keep every stored row. Residual: a box that lost exactly its newest
 *   messages, kept its root, then took a prompt looks the same as a rewind.
 * - Root guard: a read of a root the session no longer runs (re-pinned since the read began)
 *   writes nothing (`current`); merged under the new root it would re-sequence the old root's rows.
 * - No size cap: every read is written. A capture over `SESSION_LOG_RESTORE_MAX_BYTES` runs in a
 *   Worker (`captureInThread`, `lib/session-transcript-capture.ts`), off the API's event loop.
 * - Stale: another capture that wrote since `before` was read skips this write (`current`).
 */
export async function writeSessionLogFromRead(
  sessionId: string,
  input: { root: string; rows: V1Row[]; complete: boolean; before: { rows: V1Row[]; stored: StoredMessage[] } },
): Promise<MirrorLogWrite> {
  try {
    if (!config.SESSION_LOG_INGEST_ENABLED) return SKIPPED;
    const [s] = await db
      .select({
        projectId: projectSessions.projectId,
        accountId: projectSessions.accountId,
        journalSeenAt: sessionLogs.journalSeenAt,
        harness: sessionRuntimeProjections.harness,
      })
      .from(projectSessions)
      .leftJoin(sessionLogs, eq(sessionLogs.sessionId, projectSessions.sessionId))
      .leftJoin(sessionRuntimeProjections, eq(sessionRuntimeProjections.sessionId, projectSessions.sessionId))
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!s || s.journalSeenAt) return SKIPPED;
    const read = new Set(input.rows.map(idOf));
    const rewound = rewoundIds(input, s.harness === 'pi' || input.root.startsWith('ses_pi'));
    const rows = [...input.before.rows.filter((row) => !read.has(idOf(row)) && !rewound.has(idOf(row))), ...input.rows];
    const rev = maxCaptureRev(input.before.stored);
    return await writeConverted(sessionId, { ...s, root: input.root }, rows, input.before.stored, {
      puts: read,
      tombstones: rewound,
      current: async (tx) => {
        const [pin] = await tx.select({ root: projectSessions.runtimeSessionId }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
        if (pin?.root && pin.root !== input.root) return false;
        return maxCaptureRev(await storedMessages(tx, sessionId)) === rev;
      },
    });
  } catch (err) {
    logger.warn('[session-log] capture write failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' };
  }
}

const createdOf = (row: V1Row) => {
  const at = (row.info as { time?: { created?: unknown } } | null)?.time?.created;
  return typeof at === 'number' && Number.isFinite(at) ? at : -Infinity;
};

/**
 * The stored root messages an OpenCode rewind removed: see `writeSessionLogFromRead`. A revert drops
 * the newest messages after a point, so the lacking messages must be a suffix of the stored root
 * history (every stored root message after the oldest lacking one lacks too) that a newer read
 * message follows. A hole (an older message gone, a newer one kept) is lost box state: nothing.
 */
function rewoundIds(input: { root: string; rows: V1Row[]; complete: boolean; before: { rows: V1Row[] } }, pi: boolean): Set<string> {
  if (!input.complete || pi) return new Set();
  const read = new Set(input.rows.map(idOf));
  const newest = Math.max(...input.rows.filter((row) => row.runtime_session_id === input.root).map(createdOf));
  const stored = input.before.rows.filter((row) => row.runtime_session_id === input.root);
  const lacking = stored.filter((row) => !read.has(idOf(row)));
  if (lacking.length === 0) return new Set();
  const from = Math.min(...lacking.map(createdOf));
  const suffix = stored.every((row) => createdOf(row) < from || !read.has(idOf(row)));
  return suffix && lacking.every((row) => createdOf(row) < newest) ? new Set(lacking.map(idOf)) : new Set();
}

/**
 * `fromV1` of `rows` as the v1 read serves them (see `writeConverted`), with the harness the capture
 * picks. Null when the log fails `SessionLogSchema`.
 */
async function convertRows(sessionId: string, s: { harness: string | null; root: string | null }, rows: V1Row[]) {
  const harnessFrom = s.harness === 'pi' || s.harness === 'opencode' ? 'projection' : s.root?.startsWith('ses_pi') ? 'root' : 'default';
  const harness = harnessFrom === 'projection' ? (s.harness as 'pi' | 'opencode') : harnessFrom === 'root' ? 'pi' : 'opencode';
  const served = rows.map((row) => (Array.isArray(row.parts) ? { ...row, parts: restoreStrippedToolParts(row.parts as unknown as Array<Record<string, unknown>>) as unknown as V1Row['parts'] } : row));
  const log = fromV1({ session_id: sessionId, root_id: s.root, rows: served }, { harness });
  await breathe();
  const valid = SessionLogSchema.safeParse(log);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    logger.warn('[session-log] capture: fromV1 output fails SessionLogSchema; nothing written', { sessionId, path: issue?.path.join('.'), code: issue?.code });
    return null;
  }
  await breathe();
  return { log, served, harnessFrom: harnessFrom as 'projection' | 'root' | 'default' };
}

/**
 * `fromV1` of `rows` written through the journal's apply path. Only a message whose `content_hash`
 * changed is put, at the next capture rev. `puts` limits the puts to those message ids and the
 * tombstones to the stored ids in `tombstones`; without it, a stored message `fromV1` no longer
 * gives gets a tombstone.
 *
 * The rows convert as the v1 read serves them: a call the old mirror stripped (before 2026-09-28)
 * gets back the input its `title` and `metadata` prove (`restoreStrippedToolParts`), so the log, its
 * `grade_counts.tool_input` and a restore hold it. The result's `rows` are these served rows.
 */
async function writeConverted(
  sessionId: string,
  s: { projectId: string; accountId: string; harness: string | null; root: string | null },
  rows: V1Row[],
  stored: StoredMessage[],
  options: { dry?: boolean; puts?: ReadonlySet<string>; tombstones?: ReadonlySet<string>; current: (tx: Tx) => Promise<boolean> },
): Promise<MirrorLogWrite> {
  const converted = await convertRows(sessionId, s, rows);
  if (!converted) return { outcome: 'invalid' };
  const { log, served, harnessFrom } = converted;
  const { threads, ...session } = log;
  const byId = new Map(stored.map((r) => [r.id, r]));
  let rev = maxCaptureRev(stored);
  // Generation 0: a restore claims generation + 1 (`session-log-restore.ts`), so a restored session's capture answers 409 and is skipped.
  const batch: SessionLogJournalRequest = { generation: 0, session, threads: threads.map(({ messages: _m, ...t }) => t), puts: [], tombstones: [] };
  const live = new Set<string>();
  for (const m of threads.flatMap((t) => t.messages)) {
    live.add(m.message_id);
    if (options.puts && !options.puts.has(m.message_id)) continue;
    const prior = byId.get(m.message_id);
    if (prior && !prior.deletedAt && prior.hash === sessionLogContentHash(m)) continue;
    batch.puts.push({ rev: ++rev, message: m });
  }
  for (const r of stored) {
    if (!r.deletedAt && (options.puts ? options.tombstones?.has(r.id) : !live.has(r.id))) batch.tombstones.push({ message_id: r.id, rev: ++rev });
  }
  await breathe();
  if (batch.puts.length === 0 && batch.tombstones.length === 0) return SKIPPED;
  if (rev >= SESSION_LOG_CAPTURE_REV_LIMIT) {
    logger.warn('[session-log] capture revs exhausted; the capture writes no more v2 rows', { sessionId });
    return SKIPPED;
  }
  if (options.dry) return { outcome: 'dry', log, rows: served, batch, harnessFrom };

  const outcome = await writeCapturedSessionLog({ sessionId, projectId: s.projectId, accountId: s.accountId }, batch, options.current);
  if (outcome === 'skipped') return SKIPPED;
  if (outcome.status !== 200) {
    logger.warn('[session-log] capture write refused', { sessionId, status: outcome.status, body: outcome.body });
    return { outcome: 'failed', status: outcome.status };
  }
  return { outcome: 'written', log, rows: served, batch, harnessFrom };
}

/** The `ext` key that marks every message and thread record the mirror merge wrote. */
export const MIRROR_MERGE_EXT = 'kortix-mirror-merge';
const MERGE_MARK = { [MIRROR_MERGE_EXT]: { version: 'kortix.mirror-merge.v1' } };

/**
 * - `merged`: `merged` messages written, `threads` thread rows created. `misplaced`: of `merged`, messages
 *   whose seq could not go before every newer stored message of their thread. `unplaced`: missing mirror
 *   messages this pass cannot write (a compaction summary whose marker message the log holds).
 *   `oversize`: missing mirror messages too large for this process (see `mergeMirrorIntoLog`), not
 *   merged. `deferred`: missing mirror messages over this merge's byte cap, left for a later pass.
 * - `skipped`: the switch is off, the mirror is drained, nothing is missing, another writer holds the
 *   session lock, or the capture revs are exhausted. `invalid`, `failed`: as `MirrorLogWrite`.
 */
export type MirrorMerge =
  | { outcome: 'skipped' | 'invalid' | 'failed' }
  | { outcome: 'merged'; merged: number; threads: number; misplaced: number; unplaced: number; oversize: number; deferred: number };

/** The mirror message ids of one session whose content the log lacks (`kortix.mirror_messages_missing_from_log`). */
async function missingIds(tx: Tx, sessionId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ message_id: string }>(sql`
    SELECT message_id FROM kortix.mirror_messages_missing_from_log(ARRAY[${sessionId}]::text[]) WHERE content = 'missing'`);
  return new Set(rows.map((r) => r.message_id));
}

type SkeletonRow = V1Row & { message_id: string };

/**
 * Every mirror row of one session, cut down in SQL to what `fromV1` reads to place a message: its
 * order (`info.id`, `info.time`), its thread (`runtime_session_id`, and the tool calls that name another
 * runtime session: `spawnerOf`), its compaction pair (`role`, `summary` as a boolean, `parentID`, the
 * compaction parts) and a new thread's head (`agent`). A tool call keeps its `callID`, `tool`, a string
 * `state.metadata.sessionId`, and `state.names`: every other runtime session id its state's JSON
 * contains (`strpos` on the jsonb text equals `JSON.stringify(...).includes` for an id with no character
 * JSON escapes). Every other part and info key is dropped. So `fromV1` places every message as the whole
 * mirror would, in memory that grows with the row count, not the bytes.
 *
 * `names` lists only the ids no call names by `state.metadata.sessionId`: `spawnerOf` reads the substring
 * fallback for those ids alone, and a call that names a session exactly is kept for its `sessionId`. The
 * `strpos` scan is tool states x ids: on prod, a 182 MB mirror with 479 runtime sessions ran past 2 min with
 * every id and takes 3.3 s with the 1 id no call names (2026-10-27).
 */
async function mirrorSkeleton(tx: Tx, sessionId: string): Promise<SkeletonRow[]> {
  // Postgres reads every tool state of the mirror as text: allow more than the pool's 25 s on a mirror of hundreds of MB.
  await tx.execute(sql`set local statement_timeout = '2min'`);
  return tx.execute<SkeletonRow>(sql`
    WITH ids AS MATERIALIZED (
      SELECT DISTINCT opencode_session_id AS g FROM kortix.session_transcript_messages
       WHERE session_id = ${sessionId} AND opencode_session_id <> ''
      EXCEPT
      SELECT e.p #>> '{state,metadata,sessionId}' FROM kortix.session_transcript_messages c,
             jsonb_array_elements(CASE WHEN jsonb_typeof(c.parts) = 'array' THEN c.parts ELSE '[]' END) e(p)
       WHERE c.session_id = ${sessionId} AND e.p ->> 'type' = 'tool'
         AND jsonb_typeof(e.p #> '{state,metadata,sessionId}') = 'string'
         AND c.opencode_session_id IS DISTINCT FROM e.p #>> '{state,metadata,sessionId}')
    SELECT m.message_id, m.opencode_session_id AS runtime_session_id,
           CASE WHEN jsonb_typeof(m.info) <> 'object' THEN m.info ELSE coalesce((
             SELECT jsonb_object_agg(f.k, CASE WHEN f.k = 'summary' THEN to_jsonb(f.v = 'true'::jsonb) ELSE f.v END)
               FROM jsonb_each(m.info) f(k, v) WHERE f.k IN ('id', 'role', 'time', 'parentID', 'summary', 'agent')), '{}') END AS info,
           coalesce((
             SELECT jsonb_agg(CASE WHEN e.p ->> 'type' = 'compaction' THEN e.p ELSE jsonb_build_object(
                      'type', 'tool', 'callID', e.p -> 'callID', 'tool', e.p -> 'tool', 'state', jsonb_build_object(
                        'metadata', CASE WHEN jsonb_typeof(e.p #> '{state,metadata,sessionId}') = 'string'
                                         THEN jsonb_build_object('sessionId', e.p #> '{state,metadata,sessionId}') ELSE '{}'::jsonb END,
                        'names', n.names)) END ORDER BY e.i)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts) = 'array' THEN m.parts ELSE '[]' END) WITH ORDINALITY e(p, i)
               CROSS JOIN LATERAL (SELECT CASE WHEN e.p ->> 'type' = 'tool' AND jsonb_typeof(e.p -> 'state') = 'object' THEN (e.p -> 'state')::text END AS state) s
               CROSS JOIN LATERAL (SELECT jsonb_agg(ids.g) AS names FROM ids WHERE ids.g IS DISTINCT FROM m.opencode_session_id AND strpos(s.state, ids.g) > 0) n
              WHERE jsonb_typeof(e.p) = 'object' AND (e.p ->> 'type' = 'compaction' OR n.names IS NOT NULL
                    OR (e.p ->> 'type' = 'tool' AND jsonb_typeof(e.p #> '{state,metadata,sessionId}') = 'string'))), '[]') AS parts
      FROM kortix.session_transcript_messages m
     WHERE m.session_id = ${sessionId}
     ORDER BY m.message_id`);
}

/** A summary row `fromV1` folds into its compaction marker's message (`parentID`). */
const foldsInto = (info: unknown): string | null => {
  const i = info as { role?: unknown; summary?: unknown; parentID?: unknown } | null;
  return i?.role === 'assistant' && i.summary === true && typeof i.parentID === 'string' ? i.parentID : null;
};

const push = (map: Map<string, string[]>, key: string, id: string) => {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
};

/**
 * What the merge of `missing` converts (see `mergeMirrorIntoLog`): `rows`, the skeleton with the full
 * rows of the messages it takes in their place (none taken: empty); `taken`, those row ids; `folded`,
 * the summary row ids each marker folds; `left`, the missing messages it did not take and their bytes.
 */
async function readMissingRows(tx: Tx, sessionId: string, missing: ReadonlySet<string>) {
  const skeleton = await mirrorSkeleton(tx, sessionId);
  // One unit per message to write: its row and the summary rows that fold into it.
  const units = new Map<string, string[]>();
  const folded = new Map<string, string[]>();
  for (const r of skeleton) {
    const into = foldsInto(r.info);
    if (into) push(folded, into, r.message_id);
    push(units, into ?? r.message_id, r.message_id);
  }
  const wanted = [...units.values()].filter((ids) => ids.some((id) => missing.has(id)));
  const t = sessionTranscriptMessages;
  const scope = (ids: string[]) => and(eq(t.sessionId, sessionId), inArray(t.messageId, ids));
  const sizes = await tx
    .select({ id: t.messageId, bytes: sql<string>`(octet_length(${t.info}::text) + coalesce(octet_length(${t.parts}::text), 0))::bigint` })
    .from(t)
    .where(scope(wanted.flat()));
  const bytesOf = new Map(sizes.map((r) => [r.id, Number(r.bytes)]));
  const taken = new Set<string>();
  const left = { oversize: 0, oversizeBytes: 0, deferred: 0, deferredBytes: 0, limit: 0 };
  let takenBytes = 0;
  for (const ids of wanted) {
    const bytes = ids.reduce((n, id) => n + (bytesOf.get(id) ?? 0), 0);
    const count = ids.filter((id) => missing.has(id)).length;
    const room = threadRoom(bytes);
    left.limit = room.limit;
    if (!room.everFits) {
      left.oversize += count;
      left.oversizeBytes += bytes;
    } else if (takenBytes + bytes <= config.SESSION_LOG_RESTORE_MAX_BYTES || (taken.size === 0 && room.fits)) {
      for (const id of ids) taken.add(id);
      takenBytes += bytes;
    } else {
      left.deferred += count;
      left.deferredBytes += bytes;
    }
  }
  if (taken.size === 0) return { rows: [] as V1Row[], taken, folded, left };
  const full = await tx.select({ id: t.messageId, runtime_session_id: t.runtimeSessionId, info: t.info, parts: t.parts }).from(t).where(scope([...taken]));
  const byId = new Map(full.map(({ id, ...row }) => [id, row as unknown as V1Row]));
  return { rows: skeleton.map(({ message_id, ...stub }) => byId.get(message_id) ?? stub), taken, folded, left };
}

/** `created_at` in ms, a missing one first; then the id: the v1 order the hooks render (`toV1`). */
const v1Key = (at: number, id: string) => ({ at: Number.isFinite(at) ? at : -Infinity, id });
const keyBefore = (a: { at: number; id: string }, b: { at: number; id: string }) => a.at < b.at || (a.at === b.at && a.id < b.id);

/**
 * Release B prerequisite: write into an existing session log the v1 mirror messages whose content it
 * lacks (`kortix.mirror_messages_missing_from_log`, the one definition the Release B guard reads too).
 * Only the backfill's merge pass calls it (`session-log-backfill.ts`).
 *
 * - Reads only what it writes. `mirrorSkeleton` places every message; full rows are read only for the
 *   missing messages, each with the rows that fold into it (a compaction marker and its summaries; a
 *   mirror `message_id` is its `info.id`). `fromV1` builds a message from its own row, its summary,
 *   its thread and its place, so `convertRows` of the skeleton with those rows in place gives each of
 *   them exactly as the whole mirror's conversion does. Memory grows with the missing rows' bytes:
 *   no size cap and no thread (a mirror over the cap merged nothing from 2026-10-23: its thread
 *   never had room and the session was deferred every pass).
 * - Memory, per message (its rows' JSON bytes, as `threadRoom` estimates them, `lib/thread-memory.ts`):
 *   - `oversize`: 12x its bytes is over 75 % of the memory limit (`everFits` false): it never fits
 *     this process. It is not merged, one WARN per session names the session, the count and the bytes,
 *     and it stays missing, so `mergedMissing` stays false and Release B waits for a person: raise the
 *     limit (`SESSION_LOG_BACKFILL_MEMORY_MB` and the task's memory) or decide to drop that content.
 *   - One merge takes messages up to `SESSION_LOG_RESTORE_MAX_BYTES` of JSON in all (the in-process
 *     bound the conversion has), or one larger message alone while RSS plus 12x its bytes stays under
 *     75 % of the limit (`fits`). The rest is `deferred` to the next pass, with one WARN.
 * - Records: `convertRows` of those rows. A message is written when its id, or the id of the
 *   compaction summary row `fromV1` folds into it, is missing, and the log does not hold its id.
 *   Each record keeps `fromV1`'s fields and gets `ext[MIRROR_MERGE_EXT]`.
 * - Threads: `fromV1`'s root thread is the log's root thread (parent null) when the log has one. A
 *   thread the log lacks gets its `fromV1` row (marked too), its parent mapped the same way.
 * - Order: the hooks render a thread in seq order. Each message takes the first seq that no row of
 *   its thread holds (tombstones included) above every seq of the thread's live rows that come before
 *   it in v1 order (`created_at`, then id) and above the merged message before it. So a message lands
 *   in its place when the thread has a free seq there; else just after it (`misplaced`).
 * - Revs: capture revs (below `SESSION_LOG_CAPTURE_REV_LIMIT`), so the rows are provisional as a
 *   capture's: a journal put that later claims the same seq wins, and the merged row becomes a
 *   tombstone at seq `-rev` (kept, still marked). Generation: the session's.
 * - `in_context`: false when a journal wrote the log (as P3.3 takes capture rows out of context: the
 *   model view is the native store's); else `fromV1`'s.
 * - Nothing stored changes: thread rows insert on no conflict, messages are new ids. One transaction
 *   under the session's advisory lock (try: a busy lock skips; the next pass retries), and the missing
 *   set is read again under it, so a second pass merges nothing.
 */
export async function mergeMirrorIntoLog(sessionId: string): Promise<MirrorMerge> {
  try {
    if (!config.SESSION_LOG_INGEST_ENABLED) return SKIPPED;
    if (await mirrorDrained()) return SKIPPED;
    const read = await db.transaction(async (tx) => {
      const missing = await missingIds(tx, sessionId);
      if (missing.size === 0) return null;
      const [s] = await tx
        .select({ projectId: projectSessions.projectId, accountId: projectSessions.accountId, harness: sessionRuntimeProjections.harness, root: sessionTranscriptMirrors.runtimeSessionId })
        .from(projectSessions)
        .innerJoin(sessionTranscriptMirrors, eq(sessionTranscriptMirrors.sessionId, projectSessions.sessionId))
        .leftJoin(sessionRuntimeProjections, eq(sessionRuntimeProjections.sessionId, projectSessions.sessionId))
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      if (!s) return null;
      return { s, missing, ...(await readMissingRows(tx, sessionId, missing)) };
    }, READ_ONLY);
    if (!read) return SKIPPED;
    const { left } = read;
    if (left.oversize > 0) {
      logger.warn('[session-log] mirror merge: messages too large for this process are not merged; the merge stays pending until a person decides', {
        sessionId, messages: left.oversize, bytes: left.oversizeBytes, limit_bytes: left.limit,
      });
    }
    if (left.deferred > 0) {
      logger.warn('[session-log] mirror merge deferred: messages over the cap of one merge wait for the next pass', {
        sessionId, messages: left.deferred, bytes: left.deferredBytes, cap_bytes: config.SESSION_LOG_RESTORE_MAX_BYTES,
      });
    }
    if (read.taken.size === 0) return { outcome: 'merged', merged: 0, threads: 0, misplaced: 0, unplaced: 0, oversize: left.oversize, deferred: left.deferred };
    const converted = await convertRows(sessionId, read.s, read.rows);
    if (!converted) return { outcome: 'invalid' };
    const { log } = converted;
    const idsOf = (m: SessionLogMessage) => [m.message_id, ...(read.folded.get(m.message_id) ?? [])];
    // The missing messages this merge read in full: only those may be written or counted unplaced.
    const loaded = new Set([...read.missing].filter((id) => read.taken.has(id)));
    const fromRoot = log.threads.find((t) => t.parent_thread_id === null)?.thread_id;
    const scope = { sessionId, projectId: read.s.projectId, accountId: read.s.accountId };
    // Large texts go to their objects before the transaction, as the ingest does.
    const candidates: Array<{ thread: SessionLogThread; message: SessionLogMessage; record: SessionLogMessage }> = [];
    for (const thread of log.threads) {
      for (const m of thread.messages) {
        if (!idsOf(m).some((id) => loaded.has(id))) continue;
        const message = jsonbSafeValue(m);
        candidates.push({ thread, message, record: await offloadLargeTexts(scope, message) });
      }
    }
    await breathe();
    return await db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`session-log:${sessionId}`})) AS locked`);
      if (!lock?.locked) return SKIPPED;
      const missing = await missingIds(tx, sessionId);
      if (missing.size === 0) return SKIPPED;
      const [stored] = await tx.select({ generation: sessionLogs.generation, journalSeenAt: sessionLogs.journalSeenAt }).from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId));
      if (!stored) return SKIPPED;
      const threads = await tx.select({ threadId: sessionLogThreads.threadId, parent: sessionLogThreads.parentThreadId }).from(sessionLogThreads).where(eq(sessionLogThreads.sessionId, sessionId)).orderBy(sessionLogThreads.createdAt, sessionLogThreads.threadId);
      const messages = await tx
        .select({ id: sessionLogMessages.messageId, threadId: sessionLogMessages.threadId, seq: sessionLogMessages.seq, rev: sessionLogMessages.rev, createdAt: sessionLogMessages.createdAt, deletedAt: sessionLogMessages.deletedAt })
        .from(sessionLogMessages)
        .where(eq(sessionLogMessages.sessionId, sessionId));
      const held = new Set(messages.map((m) => m.id));
      const logRoot = threads.find((t) => t.parent === null)?.threadId;
      const mapThread = (id: string | null) => (id !== null && id === fromRoot && logRoot ? logRoot : id);
      const picked = candidates.filter((c) => !held.has(c.message.message_id) && idsOf(c.message).some((id) => missing.has(id)));
      const covered = new Set(picked.flatMap((c) => idsOf(c.message)));
      const unplaced = [...missing].filter((id) => loaded.has(id) && !covered.has(id)).length;
      let rev = messages.reduce((max, r) => (r.rev < SESSION_LOG_CAPTURE_REV_LIMIT ? Math.max(max, r.rev) : max), 0);
      if (rev + picked.length >= SESSION_LOG_CAPTURE_REV_LIMIT) {
        logger.warn('[session-log] mirror merge: capture revs exhausted; nothing merged', { sessionId });
        return SKIPPED;
      }
      // Thread rows the log lacks, from `fromV1`, marked.
      const known = new Set(threads.map((t) => t.threadId));
      const newThreads = new Map<string, SessionLogThread>();
      for (const { thread } of picked) {
        const id = mapThread(thread.thread_id)!;
        if (known.has(id) || newThreads.has(id)) continue;
        const { messages: _m, ...head } = thread;
        newThreads.set(id, { ...head, thread_id: id, parent_thread_id: mapThread(thread.parent_thread_id), ext: { ...head.ext, ...MERGE_MARK }, messages: [] });
      }
      if (newThreads.size > 0) {
        await tx
          .insert(sessionLogThreads)
          .values([...newThreads.values()].map(({ messages: _m, ...t }) => ({ sessionId, threadId: t.thread_id, parentThreadId: t.parent_thread_id, v: t.v, record: t as unknown as Record<string, unknown> })))
          .onConflictDoNothing();
      }
      // Seqs, per thread, in v1 order (see the header).
      const keyOf = (m: SessionLogMessage) => v1Key(Date.parse(m.created_at), m.message_id);
      picked.sort((a, b) => (keyBefore(keyOf(a.message), keyOf(b.message)) ? -1 : keyBefore(keyOf(b.message), keyOf(a.message)) ? 1 : 0));
      const perThread = new Map<string, { taken: Set<number>; live: Array<{ key: ReturnType<typeof v1Key>; seq: number }>; last: number }>();
      for (const m of messages) {
        const t = perThread.get(m.threadId) ?? perThread.set(m.threadId, { taken: new Set(), live: [], last: 0 }).get(m.threadId)!;
        t.taken.add(m.seq);
        if (!m.deletedAt) t.live.push({ key: v1Key(m.createdAt.getTime(), m.id), seq: m.seq });
      }
      let misplaced = 0;
      for (const c of picked) {
        const threadId = mapThread(c.thread.thread_id)!;
        const t = perThread.get(threadId) ?? perThread.set(threadId, { taken: new Set(), live: [], last: 0 }).get(threadId)!;
        const key = keyOf(c.message);
        let seq = t.last;
        for (const m of t.live) if (keyBefore(m.key, key)) seq = Math.max(seq, m.seq);
        seq = Math.max(seq, 0) + 1;
        while (t.taken.has(seq)) seq++;
        if (t.live.some((m) => keyBefore(key, m.key) && m.seq < seq)) misplaced++;
        t.taken.add(seq);
        t.last = seq;
        const patch = { thread_id: threadId, seq, in_context: stored.journalSeenAt ? false : c.message.in_context, ext: { ...c.message.ext, ...MERGE_MARK } };
        await applyPut(tx, sessionId, stored.generation, { rev: ++rev, message: { ...c.message, ...patch } }, { ...c.record, ...patch });
      }
      return { outcome: 'merged' as const, merged: picked.length, threads: newThreads.size, misplaced, unplaced, oversize: left.oversize, deferred: left.deferred };
    });
  } catch (err) {
    logger.warn('[session-log] mirror merge failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' };
  }
}
