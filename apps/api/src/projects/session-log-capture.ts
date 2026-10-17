/**
 * The session log of a box without a journal (P2.7): after each transcript
 * capture (`lib/session-transcript-capture.ts`) wrote the v1 mirror, this
 * writes `fromV1` of the whole mirror as v2 rows through the journal's apply
 * path (`writeCapturedSessionLog`, `session-log-ingest.ts`).
 *
 * - "Without a journal" is `session_logs.journal_seen_at` null: an old daemon,
 *   a daemon in `KORTIX_SESSION_LOG_DUMP_DIR` mode, or one whose posts have not
 *   committed yet. Checked once before the read and again under the lock.
 * - Records are `fromV1` of the mirror rows: thread, message and block ids
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
 * - A newer mirror capture between the read and the write makes this write
 *   stale: `current` compares the mirror's `captured_at` under the lock and the
 *   write is skipped (the newer capture writes its own).
 * - The operator switch `SESSION_LOG_INGEST_ENABLED` gates this writer too.
 * - Size cap. The conversion is synchronous and holds the whole mirror in memory:
 *   one 200 MB session blocked a prod API task's event loop 17 s (2026-10-16).
 *   A session without a log whose mirror stores more than `mirrorStoredCap()`
 *   bytes (`pg_column_size`, read without detoasting) gets no log (`too_large`);
 *   a restore answers 413 above `SESSION_LOG_RESTORE_MAX_BYTES` anyway. A session
 *   that already has a log keeps its captures, so its log never goes stale. The
 *   stages yield to the event loop (`breathe`).
 *
 * Never throws: the mirror is the user-facing store, and a failed v2 write is
 * only a log line. The result says what happened, for the backfill of old
 * sessions (P3.1, `session-log-backfill.ts`), which converts through this
 * function so it writes exactly what the capture writes. `dry` stops before the
 * write and returns the batch it would write.
 */
import { fromV1, SessionLogSchema, type SessionLog, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import {
  projectSessions,
  sessionLogMessages,
  sessionLogs,
  sessionRuntimeProjections,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { SESSION_LOG_CAPTURE_REV_LIMIT, sessionLogContentHash, writeCapturedSessionLog } from './session-log-ingest';

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * - `skipped`: the switch is off, a journal owns the log, there is no mirror, nothing changed,
 *   a newer mirror capture ran, or the capture revs are exhausted.
 * - `invalid`: `fromV1` of the mirror fails `SessionLogSchema`; nothing written.
 * - `too_large`: no log yet, and the mirror is over the size cap; nothing read or written.
 * - `written`, or `dry` (nothing written): `log` is `fromV1` of the mirror rows `rows`, `batch` what was (would be) written.
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

export async function writeSessionLogFromMirror(sessionId: string, options: { dry?: boolean } = {}): Promise<MirrorLogWrite> {
  try {
    if (!options.dry && !config.SESSION_LOG_INGEST_ENABLED) return SKIPPED;
    const read = await db.transaction(async (tx) => {
      const [s] = await tx
        .select({
          projectId: projectSessions.projectId,
          accountId: projectSessions.accountId,
          journalSeenAt: sessionLogs.journalSeenAt,
          hasLog: sessionLogs.sessionId,
          harness: sessionRuntimeProjections.harness,
          root: sessionTranscriptMirrors.runtimeSessionId,
          capturedAt: sessionTranscriptMirrors.capturedAt,
        })
        .from(projectSessions)
        .leftJoin(sessionLogs, eq(sessionLogs.sessionId, projectSessions.sessionId))
        .leftJoin(sessionRuntimeProjections, eq(sessionRuntimeProjections.sessionId, projectSessions.sessionId))
        .leftJoin(sessionTranscriptMirrors, eq(sessionTranscriptMirrors.sessionId, projectSessions.sessionId))
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      // A journal owns the log, or there is no mirror to convert.
      if (!s || s.journalSeenAt || !s.capturedAt) return null;
      if (!s.hasLog) {
        const [size] = await tx.execute<{ bytes: string }>(sql`
          SELECT coalesce(sum(pg_column_size(info) + coalesce(pg_column_size(parts), 0)), 0)::bigint AS bytes
            FROM kortix.session_transcript_messages WHERE session_id = ${sessionId}`);
        if (Number(size?.bytes ?? 0) > mirrorStoredCap()) return TOO_LARGE;
      }
      // ponytail: the whole mirror per capture, as the capture reads the whole box history per turn end.
      const rows = await tx
        .select({ runtime_session_id: sessionTranscriptMessages.runtimeSessionId, info: sessionTranscriptMessages.info, parts: sessionTranscriptMessages.parts })
        .from(sessionTranscriptMessages)
        .where(eq(sessionTranscriptMessages.sessionId, sessionId));
      const stored = await tx
        .select({ id: sessionLogMessages.messageId, rev: sessionLogMessages.rev, hash: sessionLogMessages.contentHash, deletedAt: sessionLogMessages.deletedAt })
        .from(sessionLogMessages)
        .where(eq(sessionLogMessages.sessionId, sessionId));
      return { s, rows: rows as unknown as V1Row[], stored };
    }, READ_ONLY);
    if (!read) return SKIPPED;
    if ('outcome' in read) return read;
    const { s, rows, stored } = read;

    const harnessFrom = s.harness === 'pi' || s.harness === 'opencode' ? 'projection' : s.root?.startsWith('ses_pi') ? 'root' : 'default';
    const harness = harnessFrom === 'projection' ? (s.harness as 'pi' | 'opencode') : harnessFrom === 'root' ? 'pi' : 'opencode';
    const log = fromV1({ session_id: sessionId, root_id: s.root, rows }, { harness });
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
    let rev = stored.reduce((max, r) => (r.rev < SESSION_LOG_CAPTURE_REV_LIMIT ? Math.max(max, r.rev) : max), 0);
    const batch: SessionLogJournalRequest = { generation: 0, session, threads: threads.map(({ messages: _m, ...t }) => t), puts: [], tombstones: [] };
    const live = new Set<string>();
    for (const m of threads.flatMap((t) => t.messages)) {
      live.add(m.message_id);
      const prior = byId.get(m.message_id);
      if (prior && !prior.deletedAt && prior.hash === sessionLogContentHash(m)) continue;
      batch.puts.push({ rev: ++rev, message: m });
    }
    for (const r of stored) if (!live.has(r.id) && !r.deletedAt) batch.tombstones.push({ message_id: r.id, rev: ++rev });
    await breathe();
    if (batch.puts.length === 0 && batch.tombstones.length === 0) return SKIPPED;
    if (rev >= SESSION_LOG_CAPTURE_REV_LIMIT) {
      logger.warn('[session-log] capture revs exhausted; the capture writes no more v2 rows', { sessionId });
      return SKIPPED;
    }
    if (options.dry) return { outcome: 'dry', log, rows, batch, harnessFrom };

    const capturedAt = new Date(s.capturedAt!).getTime();
    const outcome = await writeCapturedSessionLog({ sessionId, projectId: s.projectId, accountId: s.accountId }, batch, async (tx) => {
      const [mirror] = await tx
        .select({ capturedAt: sessionTranscriptMirrors.capturedAt })
        .from(sessionTranscriptMirrors)
        .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
        .limit(1);
      return !!mirror && new Date(mirror.capturedAt).getTime() === capturedAt;
    });
    if (outcome === 'skipped') return SKIPPED;
    if (outcome.status !== 200) {
      logger.warn('[session-log] capture write refused', { sessionId, status: outcome.status, body: outcome.body });
      return { outcome: 'failed', status: outcome.status };
    }
    return { outcome: 'written', log, rows, batch, harnessFrom };
  } catch (err) {
    logger.warn('[session-log] capture write failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'failed' };
  }
}
