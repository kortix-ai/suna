/**
 * The writer of the session log for a box without a journal (P8): `writeSessionLogFromRead`, the
 * capture of `lib/session-transcript-capture.ts`. The box read goes straight into the log.
 *
 * - "Without a journal" is `session_logs.journal_seen_at` null: an old daemon,
 *   a daemon in `KORTIX_SESSION_LOG_DUMP_DIR` mode, or one whose posts have not
 *   committed yet. Checked once before the read and again under the lock.
 * - Records are `fromV1` of the rows (a call an old mirror stripped gets back its proven
 *   input: `writeConverted`): thread, message and block ids (block id = part id), seq,
 *   residuals and the `kortix.transcript.v1` ext are exactly what `fromV1` gives. `harness`
 *   is the one the daemon reported in its runtime projection
 *   (`session_runtime_projections.harness`); else `pi` when the root runtime id is pi-minted
 *   (`ses_pi` + 24 hex, `mintRootId` in kortixd `harness/pi/message-id.ts`; an OpenCode id is
 *   `ses_` + 12 hex clock chars, so it never starts with `ses_pi`); else `opencode`.
 * - The log must pass `SessionLogSchema`. One that does not is not written (`invalid`).
 * - Only a message whose `content_hash` changed is written, at the next capture
 *   rev (1, 2, ... below `SESSION_LOG_CAPTURE_REV_LIMIT`). Nothing is ever deleted here.
 * - The operator switch `SESSION_LOG_INGEST_ENABLED` gates this writer too.
 * - The stages yield to the event loop (`breathe`). A capture over the size cap runs in a
 *   Worker (`captureInThread`, `lib/session-transcript-capture.ts`).
 *
 * Never throws: a failed write is a log line and an outcome.
 */
import {
  fromV1,
  SessionLogSchema,
  toV1,
  type SessionLog,
  type SessionLogJournalRequest,
  type V1Row,
} from '@kortix/api-contract/session-log';
import { projectSessions, sessionLogMessages, sessionLogs, sessionLogThreads, sessionRuntimeProjections } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { restoreStrippedToolParts } from './lib/session-transcript-mirror';
import { SESSION_LOG_CAPTURE_REV_LIMIT, sessionLogContentHash, writeCapturedSessionLog } from './session-log-ingest';

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * - `skipped`: the switch is off, a journal owns the log, nothing changed, another capture wrote
 *   since the read, or the capture revs are exhausted.
 * - `invalid`: `fromV1` of the rows fails `SessionLogSchema`; nothing written.
 * - `written`: the changed messages were written.
 * - `failed`: the apply path refused the batch (`status`), or something threw.
 */
type CaptureLogWrite = { outcome: 'skipped' | 'invalid' | 'written' } | { outcome: 'failed'; status?: number };

const SKIPPED = { outcome: 'skipped' } as const;

/**
 * A stored log over this many bytes (`pg_column_size`) captures in a Worker. Stored JSON is about
 * 2x its `pg_column_size` (pglz; 1.3x to 5x measured on local sessions, median 2.0), so this cap is
 * about `SESSION_LOG_RESTORE_MAX_BYTES` of JSON.
 * ponytail: a fixed ratio; a session that compresses 5x passes at up to ~2.5x the restore cap.
 * Measure the stored JSON exactly (`octet_length(record::text)`) if that matters.
 */
export const storedLogCap = () => Math.floor(config.SESSION_LOG_RESTORE_MAX_BYTES / 2);

/**
 * Let timers and I/O run. The conversion of a whole history is synchronous: one step per stage
 * keeps the API task's event loop (requests, the leader lease renew) moving on a large session.
 */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

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
): Promise<CaptureLogWrite> {
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
async function convertRows(sessionId: string, s: { harness: string | null; root: string | null }, rows: V1Row[]): Promise<SessionLog | null> {
  const harness = s.harness === 'pi' || s.harness === 'opencode' ? s.harness : s.root?.startsWith('ses_pi') ? 'pi' : 'opencode';
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
  return log;
}

/**
 * `fromV1` of `rows` written through the journal's apply path. Only a message in `puts` whose
 * `content_hash` changed is put, at the next capture rev; only the stored ids in `tombstones` get a
 * tombstone.
 *
 * The rows convert as the v1 read serves them: a call an old mirror stripped (before 2026-09-28)
 * gets back the input its `title` and `metadata` prove (`restoreStrippedToolParts`), so the log, its
 * `grade_counts.tool_input` and a restore hold it.
 */
async function writeConverted(
  sessionId: string,
  s: { projectId: string; accountId: string; harness: string | null; root: string | null },
  rows: V1Row[],
  stored: StoredMessage[],
  options: { puts: ReadonlySet<string>; tombstones: ReadonlySet<string>; current: (tx: Tx) => Promise<boolean> },
): Promise<CaptureLogWrite> {
  const log = await convertRows(sessionId, s, rows);
  if (!log) return { outcome: 'invalid' };
  const { threads, ...session } = log;
  const byId = new Map(stored.map((r) => [r.id, r]));
  let rev = maxCaptureRev(stored);
  // Generation 0: a restore claims generation + 1 (`session-log-restore.ts`), so a restored session's capture answers 409 and is skipped.
  const batch: SessionLogJournalRequest = { generation: 0, session, threads: threads.map(({ messages: _m, ...t }) => t), puts: [], tombstones: [] };
  for (const m of threads.flatMap((t) => t.messages)) {
    if (!options.puts.has(m.message_id)) continue;
    const prior = byId.get(m.message_id);
    if (prior && !prior.deletedAt && prior.hash === sessionLogContentHash(m)) continue;
    batch.puts.push({ rev: ++rev, message: m });
  }
  for (const r of stored) {
    if (!r.deletedAt && options.tombstones.has(r.id)) batch.tombstones.push({ message_id: r.id, rev: ++rev });
  }
  await breathe();
  if (batch.puts.length === 0 && batch.tombstones.length === 0) return SKIPPED;
  if (rev >= SESSION_LOG_CAPTURE_REV_LIMIT) {
    logger.warn('[session-log] capture revs exhausted; the capture writes no more v2 rows', { sessionId });
    return SKIPPED;
  }

  const outcome = await writeCapturedSessionLog({ sessionId, projectId: s.projectId, accountId: s.accountId }, batch, options.current);
  if (outcome === 'skipped') return SKIPPED;
  if (outcome.status !== 200) {
    logger.warn('[session-log] capture write refused', { sessionId, status: outcome.status, body: outcome.body });
    return { outcome: 'failed', status: outcome.status };
  }
  return { outcome: 'written' };
}
