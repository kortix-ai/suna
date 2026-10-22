/**
 * Two writers of the session log for what no journal wrote.
 *
 * - `writeSessionLogFromMirror` converts a session's v1 mirror (`session_transcript_*`, written
 *   until P8) into the log. Since P8.2 nothing writes the mirror and no read serves it; this is
 *   the only reader left, and only these call it, each before it reads the log: the backfill
 *   (`session-log-backfill.ts` and its thread), a log read of a session with no log
 *   (`convertMirrorOnRead`), a restore (`restore-session.ts`), a lost-session recovery
 *   (`recover-lost-session.ts`) and a fork (`session-create.ts`). It converts only into a log
 *   with no message yet: a session whose log holds a message never reads the mirror here. Once
 *   the mirror is drained (`mirrorDrained`) it reads no mirror table at all and answers `skipped`.
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
import { fromV1, SessionLogSchema, toV1, type SessionLog, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { restoreStrippedToolParts } from './lib/session-transcript-mirror';
import { SESSION_LOG_CAPTURE_REV_LIMIT, sessionLogContentHash, writeCapturedSessionLog } from './session-log-ingest';

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
 * state, `session-log-backfill.ts`). Nothing writes the mirror since P8.2, so it stays drained.
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
    .select({ drained: sql<boolean | null>`(${sessionLogBackfillState.state} ->> 'drainedWithDeleted')::boolean` })
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
 *   and threads stay those of the whole history. Only a message the box answered is put; nothing is
 *   tombstoned (a short read cannot tell a rewind from a box that lost its state, and the log keeps
 *   no rewind marker: on such a box a rewound message stays visible).
 * - Size cap: a session without a log whose read is over `SESSION_LOG_RESTORE_MAX_BYTES` of JSON
 *   (the mirror cap, `mirrorStoredCap`, in JSON) gets no log (`too_large`).
 * - Stale: another capture that wrote since `before` was read skips this write (`current`).
 */
export async function writeSessionLogFromRead(
  sessionId: string,
  input: { root: string; rows: V1Row[]; before: { rows: V1Row[]; stored: StoredMessage[] } },
): Promise<MirrorLogWrite> {
  try {
    if (!config.SESSION_LOG_INGEST_ENABLED) return SKIPPED;
    const [s] = await db
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
    if (!s || s.journalSeenAt) return SKIPPED;
    if (!s.hasLog) {
      let chars = 0;
      for (const row of input.rows) chars += JSON.stringify(row).length;
      if (chars > config.SESSION_LOG_RESTORE_MAX_BYTES) return TOO_LARGE;
    }
    const read = new Set(input.rows.map(idOf));
    const rows = [...input.before.rows.filter((row) => !read.has(idOf(row))), ...input.rows];
    const rev = maxCaptureRev(input.before.stored);
    return await writeConverted(sessionId, { ...s, root: input.root }, rows, input.before.stored, {
      puts: read,
      current: async (tx) => maxCaptureRev(await storedMessages(tx, sessionId)) === rev,
    });
  } catch (err) {
    logger.warn('[session-log] capture write failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' };
  }
}

/**
 * `fromV1` of `rows` written through the journal's apply path. Only a message whose `content_hash`
 * changed is put, at the next capture rev. `puts` limits the puts to those message ids and turns
 * tombstones off; without it, a stored message `fromV1` no longer gives gets a tombstone.
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
  options: { dry?: boolean; puts?: ReadonlySet<string>; current: (tx: Tx) => Promise<boolean> },
): Promise<MirrorLogWrite> {
  const harnessFrom = s.harness === 'pi' || s.harness === 'opencode' ? 'projection' : s.root?.startsWith('ses_pi') ? 'root' : 'default';
  const harness = harnessFrom === 'projection' ? (s.harness as 'pi' | 'opencode') : harnessFrom === 'root' ? 'pi' : 'opencode';
  const served = rows.map((row) => (Array.isArray(row.parts) ? { ...row, parts: restoreStrippedToolParts(row.parts as unknown as Array<Record<string, unknown>>) as unknown as V1Row['parts'] } : row));
  const log = fromV1({ session_id: sessionId, root_id: s.root, rows: served }, { harness });
  await breathe();
  const valid = SessionLogSchema.safeParse(log);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    logger.warn('[session-log] capture: fromV1 output fails SessionLogSchema; nothing written', { sessionId, path: issue?.path.join('.'), code: issue?.code });
    return { outcome: 'invalid' };
  }
  await breathe();
  const { threads, ...session } = log;
  const byId = new Map(stored.map((r) => [r.id, r]));
  let rev = maxCaptureRev(stored);
  const batch: SessionLogJournalRequest = { generation: 0, session, threads: threads.map(({ messages: _m, ...t }) => t), puts: [], tombstones: [] };
  const live = new Set<string>();
  for (const m of threads.flatMap((t) => t.messages)) {
    live.add(m.message_id);
    if (options.puts && !options.puts.has(m.message_id)) continue;
    const prior = byId.get(m.message_id);
    if (prior && !prior.deletedAt && prior.hash === sessionLogContentHash(m)) continue;
    batch.puts.push({ rev: ++rev, message: m });
  }
  if (!options.puts) for (const r of stored) if (!live.has(r.id) && !r.deletedAt) batch.tombstones.push({ message_id: r.id, rev: ++rev });
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
