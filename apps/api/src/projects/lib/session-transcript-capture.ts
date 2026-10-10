/**
 * Writing the durable transcript mirror.
 *
 * SPLIT ON PURPOSE. Capture needs `resolveSessionOpencodeEndpoint`, which lives
 * in the session-lifecycle engine and pulls most of the control plane in behind
 * it. The transcript digest only READS the mirror and must not carry that
 * graph — `session-transcript.ts` therefore imports the sibling read module and
 * turn-end reports and manual stop import this writer. (Concretely: without the
 * split, the transcript read test's `../shared/db` mock stopped
 * satisfying the engine's own imports and the whole file failed to load.)
 *
 * The rationale for capturing at TURN END — and the identity/attachment-bytes
 * rules the writer enforces — lives in `session-transcript-mirror.ts`'s header.
 */

import {
  projectSessions,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';

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
import {
  MIRROR_CAPTURE_LIMIT,
  capturedMessageIndex,
  childSessionReferences,
  childSessionsToCapture,
  capturedPageGate,
  headCompleteAfterCapture,
  mirrorHoldsStrippedRows,
  mirrorRowsFromOpencodePayload,
} from './session-transcript-mirror';

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
   * ended — one page. A tail read never deletes: it cannot tell "gone" from
   * "not read that far".
   */
  scope?: 'auto' | 'tail';
  /** Use the authenticated caller for a manual stop, not a possibly revoked creator. */
  actorUserId?: string;
}

export interface CaptureDeps {
  readMessages: (
    sessionId: string,
    options?: {
      fullHistory: boolean;
      projectId?: string;
      actorUserId?: string;
    },
  ) => Promise<{
    opencodeSessionId: string;
    payload: unknown;
    headComplete?: boolean;
    /** Every page the walk meant to read was read. Only then is the payload
     *  the complete truth about which messages exist — see
     *  `TranscriptPageWalk.complete`. */
    complete?: boolean;
    /** The walk stopped at already-captured history rather than at the head.
     *  A successful stop: everything older is held. */
    caughtUp?: boolean;
    /** Sub-agent transcripts read in the same capture (see
     *  `childSessionsToCapture`). Written only when `complete`: a sub-agent's
     *  saved transcript is whole or absent. */
    children?: Array<{ opencodeSessionId: string; payload: unknown; complete?: boolean }>;
  } | null>;
}

/** Sub-agent transcripts one capture reads at most. A finished sub-agent is
 *  read once in its life, so this bounds only a backlog (a history captured
 *  before sub-agents were saved), which later captures work through. */
const MAX_CHILD_READS_PER_CAPTURE = 12;
/** Only an OpenCode session id may reach a URL or a row. */
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{1,124}$/;

const liveCaptureDeps: CaptureDeps = {
  async readMessages(sessionId, options) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId, options?.actorUserId);
    if (!resolved) return null;
    const deadline = AbortSignal.timeout(options?.fullHistory ? 60_000 : CAPTURE_TIMEOUT_MS);
    // Every stored row of this session: the root's, and each saved sub-agent's.
    const stored = await db
      .select({
        messageId: sessionTranscriptMessages.messageId,
        parts: sessionTranscriptMessages.parts,
        messageCompletedAt: sessionTranscriptMessages.messageCompletedAt,
        opencodeSessionId: sessionTranscriptMessages.runtimeSessionId,
        role: sessionTranscriptMessages.role,
      })
      .from(sessionTranscriptMessages)
      .where(eq(sessionTranscriptMessages.sessionId, sessionId));
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
    /*
      STOPPING EARLY, AND WHEN IT IS SOUND.

      Pages run newest-first, so a page whose every message is already stored
      unchanged means everything below it is stored too — but only if a
      previous capture actually REACHED the session's first message. That is
      exactly what `head_complete` records, so it is the gate. Without it, a
      mirror that never got past page three would "catch up" on page three
      forever and the head would never be captured.

      A message counts as unchanged only when it is stored AND completed AND
      its completion time matches. An uncompleted message can still grow, so it
      is never evidence of anything. A row the old mirror stored stripped (tool
      calls without their input) is not counted as stored at all, so the walk
      reads past it and this capture writes it again, 1:1.
    */
    const completedById = capturedMessageIndex(previous);
    const [mirror] = options?.fullHistory
      ? await db
          .select({ headComplete: sessionTranscriptMirrors.headComplete })
          .from(sessionTranscriptMirrors)
          .where(
            and(
              eq(sessionTranscriptMirrors.sessionId, sessionId),
              eq(sessionTranscriptMirrors.runtimeSessionId, resolved.opencodeSessionId),
            ),
          )
          .limit(1)
      : [];
    const isAlreadyCaptured = capturedPageGate({
      fullHistory: options?.fullHistory === true,
      headComplete: mirror?.headComplete === true,
      completedById,
    });
    const result = await readTranscriptPages(
      pageOf(resolved.opencodeSessionId),
      options?.fullHistory === true,
      recoveryFor(partsById(previous)),
      isAlreadyCaptured,
    );

    /*
      SUB-AGENTS. Each sub-agent runs in its own OpenCode session, and its row
      in the parent opens that transcript. References come from the rows just
      read AND the rows already stored, so a sub-agent an earlier capture never
      reached is read too. A finished sub-agent is final and is never read
      again; its own sub-agents are followed the same way.
    */
    const children: Array<{ opencodeSessionId: string; payload: unknown; complete: boolean }> = [];
    const savedChildren = new Map<string, { settled: boolean }>();
    for (const row of stored) {
      if (!row.opencodeSessionId || row.opencodeSessionId === resolved.opencodeSessionId) continue;
      const entry = savedChildren.get(row.opencodeSessionId) ?? { settled: true };
      entry.settled &&= row.role !== 'assistant' || row.messageCompletedAt !== null;
      savedChildren.set(row.opencodeSessionId, entry);
    }
    const seen = new Set([resolved.opencodeSessionId]);
    const queue = childSessionsToCapture({
      references: childSessionReferences([...result.rows, ...previous]),
      stored: savedChildren,
      limit: MAX_CHILD_READS_PER_CAPTURE,
    });
    while (queue.length > 0 && children.length < MAX_CHILD_READS_PER_CAPTURE) {
      const child = queue.shift()!;
      if (seen.has(child) || !OPENCODE_SESSION_ID.test(child)) continue;
      seen.add(child);
      try {
        const walk = await readTranscriptPages(
          pageOf(child),
          true,
          recoveryFor(partsById(stored.filter((row) => row.opencodeSessionId === child))),
        );
        children.push({ opencodeSessionId: child, payload: walk.rows, complete: walk.complete });
        queue.push(
          ...childSessionsToCapture({
            references: childSessionReferences(walk.rows),
            stored: savedChildren,
            limit: MAX_CHILD_READS_PER_CAPTURE,
          }),
        );
      } catch (err) {
        // One unreadable sub-agent never costs the conversation its capture.
        console.warn('[transcript-mirror] sub-agent read failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      opencodeSessionId: resolved.opencodeSessionId,
      payload: result.rows,
      headComplete: result.headComplete,
      complete: result.complete,
      caughtUp: result.caughtUp,
      children,
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
 * Capture the runtime transcript at turn end: the whole history, with bounded
 * retries, or one page for a `tail` (see {@link CaptureOptions.scope}).
 *
 * NEVER THROWS. Turn-end reports start capture asynchronously. Manual stop
 * awaits capture before powering off; a mirror failure must not prevent stop.
 */
async function captureSessionTranscript(
  sessionId: string,
  deps: CaptureDeps = liveCaptureDeps,
  options?: CaptureOptions,
): Promise<CaptureResult | null> {
  try {
    const [session] = await db
      .select({
        projectId: projectSessions.projectId,
        accountId: projectSessions.accountId,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!session) return null;

    const fullHistory = options?.scope !== 'tail';
    const capture = async (): Promise<CaptureResult | null> => {
      const startedAt = new Date();
      const read = await deps.readMessages(sessionId, {
        fullHistory,
        projectId: session.projectId,
        actorUserId: options?.actorUserId,
      });
      if (!read) return null;
      const rows = mirrorRowsFromOpencodePayload(read.payload);
      /*
        A COMPLETE read is the only one that may speak for what does NOT exist.
        It reached the session's first message and every page in between, so an
        id it lacks is genuinely gone; that is what licenses the delete below
        and the `head_complete` claim.

        A PARTIAL full-history read — a page failed, or the daemon stopped
        advancing its cursor — used to be thrown away whole. That cost the
        newest turn its mirror until some later capture happened to succeed,
        and it was only ever necessary because the writer deleted the whole
        history before re-inserting. The writer merges now, so what was read is
        merged and nothing is claimed about the rest.
      */
      const completeRead = fullHistory && read.complete === true && read.headComplete === true;
      // A walk that stopped at already-captured history. Its rows are the
      // NEWEST ones, which is exactly the range a rewind removes from, so it
      // may delete inside the range it covered — and never below it.
      const caughtUpRead = fullHistory && read.caughtUp === true;
      if (rows.length === 0 && !completeRead) return null;

      const now = startedAt;
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
        const [existing] = await tx
          .select({
            headComplete: sessionTranscriptMirrors.headComplete,
            opencodeSessionId: sessionTranscriptMirrors.runtimeSessionId,
            capturedAt: sessionTranscriptMirrors.capturedAt,
          })
          .from(sessionTranscriptMirrors)
          .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
          .limit(1);
        if (existing && new Date(existing.capturedAt) > startedAt) return null;
        const [current] = await tx
          .select({ root: projectSessions.runtimeSessionId })
          .from(projectSessions)
          .where(eq(projectSessions.sessionId, sessionId))
          .limit(1);
        if (!current || (current.root && current.root !== read.opencodeSessionId)) return null;
        const rootChanged =
          !!existing?.opencodeSessionId && existing.opencodeSessionId !== read.opencodeSessionId;
        const previousHeadComplete = rootChanged ? false : (existing?.headComplete ?? false);
        const headComplete = fullHistory
          ? // Never `headCompleteAfterCapture` on a multi-page walk: its rule
            // is "fewer rows than the page limit means the box had no more",
            // which is only true of a SINGLE bounded page. A partial walk that
            // died after 30 rows would read as complete under it.
            completeRead || previousHeadComplete
          : headCompleteAfterCapture({
              returned: rows.length,
              limit: MIRROR_CAPTURE_LIMIT,
              previous: previousHeadComplete,
            });
        await tx
          .insert(sessionTranscriptMirrors)
          .values({
            sessionId,
            projectId: session.projectId,
            accountId: session.accountId,
            runtimeSessionId: read.opencodeSessionId,
            headComplete,
            capturedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: sessionTranscriptMirrors.sessionId,
            set: {
              runtimeSessionId: read.opencodeSessionId,
              headComplete,
              capturedAt: now,
              updatedAt: now,
            },
          });

        const readIds = rows.map((row) => String(row.info.id));
        // A changed root deletes nothing. The old root's rows keep their own
        // `opencode_session_id`, and every delete below is scoped to the root
        // it read, so a box that lost its state cannot erase the saved copy.
        if (completeRead) {
          /*
            DELETE WHAT DISAPPEARED, not everything.

            A COMPLETE full-history read IS the truth, so a stored id missing
            from it is genuinely gone upstream (a rewind) and must go. That is
            all this needs to remove — but it used to delete the session's
            entire history and rewrite it, every single turn. A partial read
            reaches neither branch: it cannot tell "gone" from "not read that
            far".

            Measured on a real PostgreSQL, one turn end on a session already
            holding 242 messages: 244 inserts + 242 deletes for the two
            messages the turn actually added. Linear in session length, paid
            per turn, so quadratic over the life of a thread — and every
            deleted row is a dead tuple for vacuum plus index churn.

            An empty read deletes everything, which is what the old code did
            too: with `fullHistory` there is no early return for zero rows, and
            a complete read of nothing is a claim that nothing is there.
          */
          // Scoped to the ROOT's rows: a saved sub-agent transcript is not in
          // this read and must not be taken for messages that vanished.
          await tx.execute(
            readIds.length > 0
              ? // `sql.param` — a bare `${readIds}` expands to one placeholder
                // PER ELEMENT, which is not an array and is not valid here.
                sql`DELETE FROM kortix.session_transcript_messages
                     WHERE session_id = ${sessionId}
                       AND opencode_session_id = ${read.opencodeSessionId}
                       AND NOT (message_id = ANY(${sql.param(readIds)}::text[]))`
              : sql`DELETE FROM kortix.session_transcript_messages
                     WHERE session_id = ${sessionId}
                       AND opencode_session_id = ${read.opencodeSessionId}`,
          );
        } else if (caughtUpRead && readIds.length > 0) {
          /*
            A rewind removes the NEWEST messages, which is the range an
            incremental walk reads. So a caught-up walk can still clear what a
            rewind removed — bounded at the oldest row it actually saw, because
            below that it read nothing and knows nothing.

            The floor is that oldest row's own key in the stored order
            (`message_created_at`, `message_id`). Rows with a NULL
            `message_created_at` sort oldest and are therefore always below the
            floor, so they are never touched here.
          */
          const oldest = rows[0];
          const floorCreatedAt = oldest ? timeField(oldest.info, 'created') : null;
          const floorId = oldest ? String(oldest.info.id) : null;
          if (floorCreatedAt && floorId) {
            const floor = floorCreatedAt.toISOString();
            await tx.execute(sql`
              DELETE FROM kortix.session_transcript_messages
               WHERE session_id = ${sessionId}
                 AND opencode_session_id = ${read.opencodeSessionId}
                 AND NOT (message_id = ANY(${sql.param(readIds)}::text[]))
                 AND message_created_at IS NOT NULL
                 AND (message_created_at > ${floor}::timestamptz
                      OR (message_created_at = ${floor}::timestamptz AND message_id >= ${floorId}))
            `);
          }
        }

        await upsertMirrorRows(tx, sessionId, read.opencodeSessionId, rows, now);

        // Each sub-agent read whole replaces its saved transcript: what it no
        // longer holds is deleted, the rest merged. A partial read writes
        // nothing, so a saved sub-agent is always whole.
        for (const child of read.children ?? []) {
          if (child.complete !== true) continue;
          const childRows = mirrorRowsFromOpencodePayload(child.payload);
          const childIds = childRows.map((row) => String(row.info.id));
          await tx.execute(
            childIds.length > 0
              ? sql`DELETE FROM kortix.session_transcript_messages
                     WHERE session_id = ${sessionId}
                       AND opencode_session_id = ${child.opencodeSessionId}
                       AND NOT (message_id = ANY(${sql.param(childIds)}::text[]))`
              : sql`DELETE FROM kortix.session_transcript_messages
                     WHERE session_id = ${sessionId}
                       AND opencode_session_id = ${child.opencodeSessionId}`,
          );
          await upsertMirrorRows(tx, sessionId, child.opencodeSessionId, childRows, now);
        }
        return { captured: rows.length, head_complete: headComplete };
      });
    };
    return fullHistory ? await retryTranscriptCapture(capture) : await capture();
  } catch (err) {
    console.warn(
      `[transcript-mirror] capture failed for session ${sessionId}:`,
      `sqlstate=${errorSqlstate(err) ?? 'unknown'}`,
    );
    return null;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Merge one OpenCode session's rows into the mirror, 100 per statement. */
async function upsertMirrorRows(
  tx: Tx,
  sessionId: string,
  opencodeSessionId: string,
  rows: ReturnType<typeof mirrorRowsFromOpencodePayload>,
  now: Date,
): Promise<void> {
  const values = rows.map((row) => ({
    sessionId,
    messageId: String(row.info.id),
    parentMessageId:
      typeof row.info.parentID === 'string' && row.info.parentID ? row.info.parentID : null,
    runtimeSessionId: opencodeSessionId,
    role: typeof row.info.role === 'string' && row.info.role ? row.info.role : 'unknown',
    messageCreatedAt: timeField(row.info, 'created'),
    messageCompletedAt: timeField(row.info, 'completed'),
    info: row.info,
    parts: row.parts as unknown[],
    capturedAt: now,
  }));
  for (let index = 0; index < values.length; index += 100) {
    await tx
      .insert(sessionTranscriptMessages)
      .values(values.slice(index, index + 100))
      .onConflictDoUpdate({
        target: [sessionTranscriptMessages.sessionId, sessionTranscriptMessages.messageId],
        set: {
          parentMessageId: sql`excluded.parent_message_id`,
          runtimeSessionId: sql`excluded.opencode_session_id`,
          role: sql`excluded.role`,
          messageCreatedAt: sql`excluded.message_created_at`,
          messageCompletedAt: sql`excluded.message_completed_at`,
          info: sql`excluded.info`,
          parts: sql`excluded.parts`,
          capturedAt: sql`excluded.captured_at`,
        },
        /*
          Rewrite a row only when it actually changed. Every turn re-reads
          the whole history, so without this the other 242 rows are
          written again to say the same thing — and an UPDATE of an
          unchanged row still costs a new tuple version and a vacuum.

          `IS DISTINCT FROM` on the two fields that carry content, not on
          `captured_at`: that moves on every capture by construction, so
          comparing it would make every row differ and the clause a no-op.
          A row whose content is unchanged keeps its older `captured_at`,
          which is honest — it says when that message was last actually
          observed to change.

          It must stay a CONTENT comparison. Attachment recovery rewrites
          the file parts of OLD messages (`recoverTranscriptAttachments`),
          and those rows differ, so they still land.
        */
        setWhere: sql`${sessionTranscriptMessages.info} IS DISTINCT FROM excluded.info
          OR ${sessionTranscriptMessages.parts} IS DISTINCT FROM excluded.parts`,
      });
  }
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
 * So a settled outcome (no such session, already whole, or a capture that
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
 * BACKFILL ON WAKE — what makes the feature work for sessions that already exist.
 *
 * Capture runs at turn end. That is the right moment to record a turn, but it
 * means a session nobody prompted since saved history shipped has NOTHING
 * saved: its mirror stays empty until somebody happens to send it another
 * message. Opening the session — the exact moment the user is waiting and the
 * feature is supposed to pay off — wrote nothing, so the second open was as
 * blank as the first.
 *
 * So: the first time a session's runtime is up, mirror what is already
 * there — only when the mirror cannot already prove it holds the session's
 * first message, and at most {@link BACKFILL_MAX_ATTEMPTS} times per process
 * (see {@link backfillAttempts} for why an attempt is not the same as a
 * result).
 *
 * Fire-and-forget by construction — `captureSessionTranscriptMirror` never
 * throws, and a backfill must never be able to fail or delay an open.
 *
 * SAFE AGAINST THE DELETE BRANCH. A complete full-history read licenses the
 * writer to remove stored ids the box no longer has. A backfill of an EMPTY
 * mirror has nothing to remove, and a backfill of a `head_complete: false`
 * mirror (a partial walk, or one pruned by the retention cap removed on
 * 2026-09-29) merges the head back rather than trimming — which is the repair
 * this is for.
 */
export function backfillSessionTranscriptMirrorOnWake(
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
      const [row] = await db
        .select({
          root: projectSessions.runtimeSessionId,
          mirrorRoot: sessionTranscriptMirrors.runtimeSessionId,
          headComplete: sessionTranscriptMirrors.headComplete,
        })
        .from(projectSessions)
        .leftJoin(
          sessionTranscriptMirrors,
          eq(sessionTranscriptMirrors.sessionId, projectSessions.sessionId),
        )
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      // No such session. Nothing will ever change that.
      if (!row) return settle();
      // Already whole, for the root this session actually runs. Nothing a
      // backfill could add — a re-pinned root is NOT whole, whatever the row says,
      // and neither is a history the old mirror stored with its tool calls
      // stripped: this wake is the one chance to read them again.
      if (
        row.headComplete &&
        row.mirrorRoot &&
        row.mirrorRoot === row.root &&
        !(await mirrorHoldsStrippedRows(sessionId))
      ) {
        return settle();
      }
      // A RESULT settles it; null means the read could not run (no pinned root
      // yet, box not reachable) and the next open is allowed to try again.
      if (await captureSessionTranscriptMirror(sessionId, deps)) settle();
    } catch (err) {
      console.warn(
        `[transcript-mirror] wake backfill failed for session ${sessionId}:`,
        `sqlstate=${errorSqlstate(err) ?? 'unknown'}`,
      );
    }
  })();
}

/** Test seam: the memo is process-global and would leak between cases. */
export function resetTranscriptBackfillMemoForTests(): void {
  backfillAttempts.clear();
}

const captures = new Map<string, Promise<CaptureResult | null>>();

export function captureSessionTranscriptMirror(
  sessionId: string,
  deps: CaptureDeps = liveCaptureDeps,
  options?: CaptureOptions,
): Promise<CaptureResult | null> {
  const previous = captures.get(sessionId) ?? Promise.resolve(null);
  const pending = previous.then(() => captureSessionTranscript(sessionId, deps, options));
  captures.set(sessionId, pending);
  void pending.finally(() => {
    if (captures.get(sessionId) === pending) captures.delete(sessionId);
  });
  return pending;
}
