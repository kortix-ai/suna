/**
 * The capture of a box without a journal: its messages read from the box go into the session log
 * (`writeSessionLogFromRead`, `../session-log-capture.ts`).
 *
 * "Without a journal" is `session_logs.journal_seen_at` null: an old daemon, a daemon in
 * `KORTIX_SESSION_LOG_DUMP_DIR` mode, or one whose first journal batch has not committed. A box
 * with a journal keeps its own log and is never read here.
 *
 * It runs at turn end (`routes/turn-stream-handlers.ts`), before a manual stop (one `tail` page,
 * `session-lifecycle/stop.ts`), on the first ready `/start` of a session (`captureJournallessSessionLogOnWake`)
 * and before a fork (`session-create.ts`). Nothing here reads or writes the v1 mirror tables
 * (P8.2); the identity/attachment-bytes rules of the rows are `session-transcript-mirror.ts`'s
 * projections.
 */

import type { V1Row } from '@kortix/api-contract/session-log';
import { projectSessions, sessionLogs } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { db } from '../../shared/db';
import { errorSqlstate } from '../../shared/error-cause';
import {
  readTranscriptPages,
  retryTranscriptCapture,
  transcriptPageUrl,
} from './session-transcript-pages';
import {
  readTranscriptAttachmentBytes,
  recoverTranscriptAttachments,
} from './session-transcript-attachments';
import { sessionAttachmentStore } from './session-attachments';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { resolveSessionOpencodeEndpoint } from '../session-lifecycle/runtime-client';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { readCapturedSessionLog, writeSessionLogFromRead } from '../session-log-capture';
import {
  MIRROR_CAPTURE_LIMIT,
  childReadFailureLog,
  childSessionReferences,
  mirrorRowsFromOpencodePayload,
  readChildTranscripts,
} from './session-transcript-mirror';
import { isRuntimeUnavailableError } from './runtime-read-failure';

const CAPTURE_TIMEOUT_MS = 8_000;

export interface CaptureResult {
  captured: number;
  head_complete: boolean;
}

export interface CaptureOptions {
  /**
   * `tail` reads ONE bounded page instead of the whole history, for a caller
   * the user is waiting on. Manual stop AWAITS its capture before powering the
   * box off, and a full-history read there is a 60s pagination with three
   * retries in front of a Stop button. The full copy is already maintained at
   * every turn end, so the only gap a stop can close is the turn that just
   * ended — one page.
   */
  scope?: 'auto' | 'tail';
  /** Use the authenticated caller for a manual stop, not a possibly revoked creator. */
  actorUserId?: string;
  /** Internal: this capture was queued by the one before it (`moreChildren`). */
  chain?: { step: number; startedAt: number };
}

export interface CaptureDeps {
  readMessages: (
    sessionId: string,
    options?: {
      fullHistory: boolean;
      projectId?: string;
      actorUserId?: string;
      /** The session log's rows (`readCapturedSessionLog`): what is already stored. */
      stored: V1Row[];
    },
  ) => Promise<{
    opencodeSessionId: string;
    payload: unknown;
    headComplete?: boolean;
    /** Every page the walk meant to read was read. Only then is the payload
     *  the complete truth about which messages exist — see
     *  `TranscriptPageWalk.complete`. */
    complete?: boolean;
    /** Sub-agent transcripts read in the same capture (see
     *  `childSessionsToCapture`). Written only when `complete`: a sub-agent's
     *  saved transcript is whole or absent. */
    children?: Array<{ opencodeSessionId: string; payload: unknown; complete?: boolean }>;
    /** Another capture saves more sub-agents: this one left some unread and saved rows of one
     *  never saved before (`readChildTranscripts`). */
    moreChildren?: boolean;
  } | null>;
}

/** Sub-agent transcripts with rows one capture saves at most. A finished
 *  sub-agent is read once in its life. A capture that leaves sub-agents unread
 *  (one turn that started more than this, or a history captured before
 *  sub-agents were saved) queues the next capture at once (`moreChildren`), up
 *  to `MAX_CAPTURE_CHAIN` in a row, so the rest are saved without waiting for
 *  another turn end. */
const MAX_CHILD_READS_PER_CAPTURE = 12;
/** Captures one capture may queue in a row: a hard stop under `moreChildren`'s progress rule. */
const MAX_CAPTURE_CHAIN = 8;

const liveCaptureDeps: CaptureDeps = {
  async readMessages(sessionId, options) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId, options?.actorUserId);
    if (!resolved) return null;
    const deadline = AbortSignal.timeout(options?.fullHistory ? 60_000 : CAPTURE_TIMEOUT_MS);
    // Every stored row of this session: the root's, and each saved sub-agent's.
    const stored = (options?.stored ?? []).map((row) => ({
      messageId: String(row.info?.id ?? ''),
      parts: row.parts,
      messageCompletedAt: timeField(row.info, 'completed'),
      opencodeSessionId: row.runtime_session_id,
      role: typeof row.info?.role === 'string' ? row.info.role : 'unknown',
    }));
    const previous = stored.filter((row) => row.opencodeSessionId === resolved.opencodeSessionId);
    const partsById = (rows: typeof stored) =>
      new Map(rows.map((row) => [row.messageId, row.parts as Record<string, unknown>[]]));

    /** One page of an OpenCode session's messages, newest first. */
    const pageOf = (opencodeSessionId: string) => async (cursor?: string) => {
      const url = transcriptPageUrl(
        resolved.endpoint.url,
        opencodeSessionId,
        cursor,
        MIRROR_CAPTURE_LIMIT,
      );
      return fetch(url, {
        headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]),
      });
    };
    /** Attachment recovery for one OpenCode session, against its stored parts. */
    const recoveryFor = (savedParts: Map<string, Record<string, unknown>[]>) =>
      options?.projectId
        ? (messages: unknown[]) =>
            recoverTranscriptAttachments({
              messages,
              previous: savedParts,
              projectId: options.projectId!,
              sessionId,
              recover: options.fullHistory,
              signal: deadline,
              readFile: async (path) => {
                const response = await fetch(
                  `${resolved.endpoint.url}/file/raw?path=${encodeURIComponent(path)}`,
                  {
                    headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
                    signal: AbortSignal.any([deadline, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]),
                  },
                );
                if (response.status === 404) {
                  await response.body?.cancel();
                  return null;
                }
                return readTranscriptAttachmentBytes(response);
              },
              saveFile: (file) => sessionAttachmentStore().put(file),
              onFailure: (filename, error) =>
                console.warn('[transcript-attachments] recovery failed', {
                  sessionId,
                  filename,
                  error: error instanceof Error ? error.message : String(error),
                }),
            })
        : undefined;
    // ponytail: the log records no `head_complete`, so a capture walks the whole box history every
    // time; record it in the log when journal-less boxes with long histories matter.
    const result = await readTranscriptPages(
      pageOf(resolved.opencodeSessionId),
      options?.fullHistory === true,
      recoveryFor(partsById(previous)),
    );

    /*
      SUB-AGENTS. Each sub-agent runs in its own OpenCode session, and its row
      in the parent opens that transcript. References come from the rows just
      read AND the rows already stored, so a sub-agent an earlier capture never
      reached is read too. A finished sub-agent is final and is never read
      again; its own sub-agents are followed the same way.
    */
    const savedChildren = new Map<string, { settled: boolean }>();
    for (const row of stored) {
      if (!row.opencodeSessionId || row.opencodeSessionId === resolved.opencodeSessionId) continue;
      const entry = savedChildren.get(row.opencodeSessionId) ?? { settled: true };
      entry.settled &&= row.role !== 'assistant' || row.messageCompletedAt !== null;
      savedChildren.set(row.opencodeSessionId, entry);
    }
    const { children, more, failures } = await readChildTranscripts({
      references: childSessionReferences([...result.rows, ...previous]),
      stored: savedChildren,
      cap: MAX_CHILD_READS_PER_CAPTURE,
      root: resolved.opencodeSessionId,
      read: (child) =>
        readTranscriptPages(
          pageOf(child),
          true,
          recoveryFor(partsById(stored.filter((row) => row.opencodeSessionId === child))),
        ),
    });
    // One line per capture. Expected states — a stopped box, gone transcripts —
    // log info; only an unexpected failure warns. See `childReadFailureLog`.
    const failureLine = childReadFailureLog(failures);
    if (failureLine) {
      const context = { sessionId, ...failureLine.context };
      if (failureLine.level === 'warn') console.warn(failureLine.message, context);
      else logger.info(failureLine.message, context);
    }

    return {
      opencodeSessionId: resolved.opencodeSessionId,
      payload: result.rows,
      headComplete: result.headComplete,
      complete: result.complete,
      children,
      moreChildren: more,
    };
  },
};

export function timeField(info: Record<string, unknown>, key: 'created' | 'completed'): Date | null {
  const time = info.time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) return null;
  const value = (time as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Capture the box's transcript into the session log: the whole history, with bounded retries, or
 * one page for a `tail` (see {@link CaptureOptions.scope}). Null for a session with a journal.
 *
 * NEVER THROWS. Turn-end reports start capture asynchronously. Manual stop
 * awaits capture before powering off; a capture failure must not prevent stop.
 */
async function captureSessionTranscript(
  sessionId: string,
  deps: CaptureDeps,
  options: CaptureOptions | undefined,
  /** When this capture's run was queued: a stop asked for after it drops the rest of the run. */
  chainStartedAt: number,
): Promise<CaptureResult | null> {
  try {
    if (!config.SESSION_LOG_INGEST_ENABLED) return null;
    const [session] = await db
      .select({ projectId: projectSessions.projectId, journalSeenAt: sessionLogs.journalSeenAt })
      .from(projectSessions)
      .leftJoin(sessionLogs, eq(sessionLogs.sessionId, projectSessions.sessionId))
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    // A journal keeps the log.
    if (!session || session.journalSeenAt) return null;
    return await captureIntoSessionLog(sessionId, deps, options, session.projectId, chainStartedAt);
  } catch (err) {
    // A stopped, gone, or cold box is the expected state of an idle session;
    // the capture fail-opens on it (returns null, the log stays as it is).
    // That degrade is info. Anything else warns, with the real error.
    const detail = err instanceof Error ? err.message : String(err);
    if (isRuntimeUnavailableError(err)) {
      logger.info(`[session-log] box capture deferred for session ${sessionId}`, {
        sessionId,
        error: detail,
        sqlstate: errorSqlstate(err) ?? 'unknown',
      });
    } else {
      console.warn(`[session-log] box capture failed for session ${sessionId}`, {
        sessionId,
        error: detail,
        sqlstate: errorSqlstate(err) ?? 'unknown',
      });
    }
    return null;
  }
}

/** The read of a box without a journal, merged into the stored log. */
async function captureIntoSessionLog(
  sessionId: string,
  deps: CaptureDeps,
  options: CaptureOptions | undefined,
  projectId: string,
  chainStartedAt: number,
): Promise<CaptureResult | null> {
  const fullHistory = options?.scope !== 'tail';
  let moreChildren = false;
  const capture = async (): Promise<CaptureResult | null> => {
    const before = await readCapturedSessionLog(sessionId);
    const read = await deps.readMessages(sessionId, { fullHistory, projectId, actorUserId: options?.actorUserId, stored: before.rows });
    if (!read) return null;
    const rows = mirrorRowsFromOpencodePayload(read.payload);
    const completeRead = fullHistory && read.complete === true && read.headComplete === true;
    if (rows.length === 0 && !completeRead) return null;
    const children = (read.children ?? []).filter((child) => child.complete === true);
    const asRows = (id: string, list: typeof rows): V1Row[] => list.map((row) => ({ runtime_session_id: id, info: row.info, parts: row.parts }) as V1Row);
    const outcome = await writeSessionLogFromRead(sessionId, {
      root: read.opencodeSessionId,
      rows: [...asRows(read.opencodeSessionId, rows), ...children.flatMap((child) => asRows(child.opencodeSessionId, mirrorRowsFromOpencodePayload(child.payload)))],
      before,
    });
    // Nothing stored (a failed, invalid or too-large write): a failure, so it is retried and a
    // wake does not mark the session captured.
    if (outcome.outcome !== 'written' && outcome.outcome !== 'skipped') return null;
    // Progress: a sub-agent the log did not hold before was written.
    const held = new Set(before.rows.map((row) => row.runtime_session_id));
    moreChildren = read.moreChildren === true && outcome.outcome === 'written' && children.some((child) => !held.has(child.opencodeSessionId));
    return { captured: rows.length, head_complete: completeRead };
  };
  const result = fullHistory ? await retryTranscriptCapture(capture) : await capture();
  const step = options?.chain?.step ?? 0;
  if (result && fullHistory && moreChildren && step < MAX_CAPTURE_CHAIN) {
    void captureJournallessSessionLog(sessionId, deps, { ...options, chain: { step: step + 1, startedAt: chainStartedAt } });
  }
  return result;
}

/**
 * Wake-backfill attempts per session, in this process.
 *
 * `/start` answers `ready` on EVERY poll once the box is up, so without a memo
 * the guard below would run one SELECT per poll for the life of the session.
 *
 * It counts rather than flags, because "considered" and "done" are not the same
 * thing. A capture can answer null for reasons that pass: `/start` reports
 * `ready` before the OpenCode root is pinned, and the box can be briefly
 * unreachable right after it comes up. Remembering that as DONE would leave the
 * session blank until some later turn end — which is the exact failure this
 * whole function exists to remove, reintroduced one level down.
 *
 * So a settled outcome (no such session, a journal, or a capture that
 * returned a result) is recorded as done and never retried; an attempt that could not run
 * leaves room for the next open to try again, and stops after
 * {@link BACKFILL_MAX_ATTEMPTS} so a permanently unreadable session cannot
 * read its box once per open forever.
 */
const backfillAttempts = new Map<string, number>();
const BACKFILL_MEMO_MAX = 10_000;
const BACKFILL_MAX_ATTEMPTS = 3;
/** Recorded for a settled session: at or above the cap, so it never retries. */
const BACKFILL_DONE = BACKFILL_MAX_ATTEMPTS;

/**
 * CAPTURE ON WAKE. Capture runs at turn end, so a journal-less box nobody prompted since it booted
 * has nothing in its log. The first time its runtime is up, read what is already there, at most
 * {@link BACKFILL_MAX_ATTEMPTS} times per process (see {@link backfillAttempts} for why an attempt
 * is not the same as a result). A session with a journal settles at once.
 *
 * Fire-and-forget by construction: `captureJournallessSessionLog` never throws, and this must never
 * be able to fail or delay an open. A capture merges and never trims, so a box that lost its state
 * deletes nothing.
 */
export function captureJournallessSessionLogOnWake(
  sessionId: string,
  deps: CaptureDeps = liveCaptureDeps,
): Promise<void> {
  const attempts = backfillAttempts.get(sessionId) ?? 0;
  if (attempts >= BACKFILL_MAX_ATTEMPTS) return Promise.resolve();
  if (backfillAttempts.size >= BACKFILL_MEMO_MAX) backfillAttempts.clear();
  // Claimed BEFORE the first await: two concurrent `/start` calls for one
  // session must not both walk its history.
  backfillAttempts.set(sessionId, attempts + 1);
  const settle = (): void => {
    backfillAttempts.set(sessionId, BACKFILL_DONE);
  };
  return (async () => {
    try {
      const [session] = await db
        .select({ journalSeenAt: sessionLogs.journalSeenAt })
        .from(projectSessions)
        .leftJoin(sessionLogs, eq(sessionLogs.sessionId, projectSessions.sessionId))
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      // No such session, or a journal keeps its log. Nothing will change that.
      if (!session || session.journalSeenAt) return settle();
      // A RESULT settles it; null means the read could not run (no pinned root
      // yet, box not reachable) and the next open is allowed to try again.
      if (await captureJournallessSessionLog(sessionId, deps)) settle();
    } catch (err) {
      console.warn(
        `[session-log] wake capture failed for session ${sessionId}:`,
        `sqlstate=${errorSqlstate(err) ?? 'unknown'}`,
      );
    }
  })();
}

/** Test seam: resolves once no capture of this session is queued or running (a run queues its
 *  next capture before its own promise settles). */
export async function transcriptCapturesSettledForTests(sessionId: string): Promise<void> {
  for (let pending = captures.get(sessionId); pending; pending = captures.get(sessionId)) {
    await pending.catch(() => null);
    if (captures.get(sessionId) === pending) captures.delete(sessionId);
  }
}

/** Test seam: the memo is process-global and would leak between cases. */
export function resetTranscriptBackfillMemoForTests(): void {
  backfillAttempts.clear();
}

const captures = new Map<string, Promise<CaptureResult | null>>();
/** replica-local: when a stop last asked for a `tail` capture, per session. A queued chain
 *  capture started before it is dropped: it would sit ahead of the next stop's tail, then
 *  read a box that is off. Bounded like `backfillAttempts`. */
const tailRequestedAt = new Map<string, number>();

export function captureJournallessSessionLog(
  sessionId: string,
  deps: CaptureDeps = liveCaptureDeps,
  options?: CaptureOptions,
): Promise<CaptureResult | null> {
  if (options?.scope === 'tail') {
    if (tailRequestedAt.size >= BACKFILL_MEMO_MAX) tailRequestedAt.clear();
    tailRequestedAt.set(sessionId, Date.now());
  }
  // A run is as old as the moment its first capture was queued, not when it started to run.
  const startedAt = options?.chain?.startedAt ?? Date.now();
  const previous = captures.get(sessionId) ?? Promise.resolve(null);
  const pending = previous.then(() => {
    if (options?.chain && (tailRequestedAt.get(sessionId) ?? -Infinity) >= startedAt) return null;
    return captureSessionTranscript(sessionId, deps, options, startedAt);
  });
  captures.set(sessionId, pending);
  void pending.finally(() => {
    if (captures.get(sessionId) === pending) captures.delete(sessionId);
  });
  return pending;
}
