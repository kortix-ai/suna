/**
 * Writing the durable transcript mirror.
 *
 * SPLIT ON PURPOSE. Capture needs `resolveSessionOpencodeEndpoint`, which lives
 * in the session-lifecycle engine and pulls most of the control plane in behind
 * it. The transcript digest only READS the mirror and must not carry that
 * graph — `session-transcript.ts` therefore imports the sibling read module and
 * turn-end reports and manual stop import this writer. (Concretely: without the
 * split, `unit-session-transcript.test.ts`'s `../shared/db` mock stopped
 * satisfying the engine's own imports and the whole file failed to load.)
 *
 * The rationale for capturing at TURN END — and the identity/attachment-bytes
 * rules the writer enforces — lives in `session-transcript-mirror.ts`'s header.
 */

import {
  projects,
  projectSessions,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { readTranscriptPages, retryTranscriptCapture } from './session-transcript-pages';
import {
  readTranscriptAttachmentBytes,
  recoverTranscriptAttachments,
} from './session-transcript-attachments';
import { sessionAttachmentStore } from './session-attachments';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { resolveSessionOpencodeEndpoint } from '../session-lifecycle/engine';
import {
  MIRROR_CAPTURE_LIMIT,
  MIRROR_MAX_MESSAGES,
  captureScope,
  capturedPageGate,
  headCompleteAfterCapture,
  mirrorRowsFromOpencodePayload,
} from './session-transcript-mirror';

const WORKSPACE_DIRECTORY = '/workspace';
const CAPTURE_TIMEOUT_MS = 8_000;

export interface CaptureResult {
  captured: number;
  head_complete: boolean;
  pruned: number;
}

export interface CaptureOptions {
  /**
   * `tail` forces ONE bounded page, whatever the project flag says. For a
   * caller the user is waiting on — see `captureScope`.
   */
  scope?: 'auto' | 'tail';
}

export interface CaptureDeps {
  readMessages: (
    sessionId: string,
    options?: {
      fullHistory: boolean;
      projectId?: string;
      retainHistory?: boolean;
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
  } | null>;
}

const liveCaptureDeps: CaptureDeps = {
  async readMessages(sessionId, options) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return null;
    const deadline = AbortSignal.timeout(options?.fullHistory ? 60_000 : CAPTURE_TIMEOUT_MS);
    const previous = options?.retainHistory
      ? await db
          .select({
            messageId: sessionTranscriptMessages.messageId,
            parts: sessionTranscriptMessages.parts,
            messageCompletedAt: sessionTranscriptMessages.messageCompletedAt,
          })
          .from(sessionTranscriptMessages)
          .where(
            and(
              eq(sessionTranscriptMessages.sessionId, sessionId),
              eq(sessionTranscriptMessages.opencodeSessionId, resolved.opencodeSessionId),
            ),
          )
      : [];
    const savedParts = new Map(
      previous.map((row) => [row.messageId, row.parts as Record<string, unknown>[]]),
    );
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
      is never evidence of anything.
    */
    const completedById = new Map(
      previous.map((row) => [row.messageId, row.messageCompletedAt?.getTime() ?? null]),
    );
    const [mirror] = options?.fullHistory
      ? await db
          .select({ headComplete: sessionTranscriptMirrors.headComplete })
          .from(sessionTranscriptMirrors)
          .where(
            and(
              eq(sessionTranscriptMirrors.sessionId, sessionId),
              eq(sessionTranscriptMirrors.opencodeSessionId, resolved.opencodeSessionId),
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
      async (cursor) => {
        const url = new URL(
          `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message`,
        );
        url.searchParams.set('directory', WORKSPACE_DIRECTORY);
        url.searchParams.set('limit', String(MIRROR_CAPTURE_LIMIT));
        if (cursor) url.searchParams.set('cursor', cursor);
        return fetch(url, {
          headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
          signal: AbortSignal.any([deadline, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]),
        });
      },
      options?.fullHistory === true,
      options?.projectId && options.retainHistory
        ? (messages) =>
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
        : undefined,
      isAlreadyCaptured,
    );
    return {
      opencodeSessionId: resolved.opencodeSessionId,
      payload: result.rows,
      headComplete: result.headComplete,
      complete: result.complete,
      caughtUp: result.caughtUp,
    };
  },
};

function timeField(info: Record<string, unknown>, key: 'created' | 'completed'): Date | null {
  const time = info.time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) return null;
  const value = (time as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value);
}

/**
 * Capture the runtime transcript at turn end. The project flag enables full
 * pagination and bounded retries; legacy projects keep the existing tail read.
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
        metadata: projects.metadata,
      })
      .from(projectSessions)
      .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!session) return null;

    const { fullHistory, retainHistory } = captureScope({
      flagEnabled: resolveFeatureFlag(session.metadata, 'session_transcript_history'),
      everRetained: session.metadata?.session_transcript_history_retained === true,
      requested: options?.scope,
    });
    const capture = async (): Promise<CaptureResult | null> => {
      const startedAt = new Date();
      const read = await deps.readMessages(sessionId, {
        fullHistory,
        projectId: session.projectId,
        retainHistory,
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
            opencodeSessionId: sessionTranscriptMirrors.opencodeSessionId,
            capturedAt: sessionTranscriptMirrors.capturedAt,
          })
          .from(sessionTranscriptMirrors)
          .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
          .limit(1);
        if (existing && new Date(existing.capturedAt) > startedAt) return null;
        const [current] = await tx
          .select({ root: projectSessions.opencodeSessionId })
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
            opencodeSessionId: read.opencodeSessionId,
            headComplete,
            capturedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: sessionTranscriptMirrors.sessionId,
            set: {
              opencodeSessionId: read.opencodeSessionId,
              headComplete,
              capturedAt: now,
              updatedAt: now,
            },
          });

        if (retainHistory && !session.metadata?.session_transcript_history_retained) {
          await tx
            .update(projects)
            .set({
              metadata: sql`jsonb_set(COALESCE(${projects.metadata}, '{}'::jsonb), '{session_transcript_history_retained}', 'true'::jsonb)`,
            })
            .where(eq(projects.projectId, session.projectId));
        }

        const readIds = rows.map((row) => String(row.info.id));
        if (rootChanged) {
          // A different OpenCode root makes every stored id unreachable.
          await tx
            .delete(sessionTranscriptMessages)
            .where(eq(sessionTranscriptMessages.sessionId, sessionId));
        } else if (completeRead) {
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
          await tx.execute(
            readIds.length > 0
              ? // `sql.param` — a bare `${readIds}` expands to one placeholder
                // PER ELEMENT, which is not an array and is not valid here.
                sql`DELETE FROM kortix.session_transcript_messages
                     WHERE session_id = ${sessionId}
                       AND NOT (message_id = ANY(${sql.param(readIds)}::text[]))`
              : sql`DELETE FROM kortix.session_transcript_messages
                     WHERE session_id = ${sessionId}`,
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
                 AND NOT (message_id = ANY(${sql.param(readIds)}::text[]))
                 AND message_created_at IS NOT NULL
                 AND (message_created_at > ${floor}::timestamptz
                      OR (message_created_at = ${floor}::timestamptz AND message_id >= ${floorId}))
            `);
          }
        }

        const values = rows.map((row) => ({
          sessionId,
          messageId: String(row.info.id),
          parentMessageId:
            typeof row.info.parentID === 'string' && row.info.parentID ? row.info.parentID : null,
          opencodeSessionId: read.opencodeSessionId,
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
                opencodeSessionId: sql`excluded.opencode_session_id`,
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
        const pruned = retainHistory ? 0 : await pruneSessionTranscriptMirror(sessionId, tx);
        return {
          captured: rows.length,
          head_complete: headComplete && pruned === 0,
          pruned,
        };
      });
    };
    return fullHistory ? await retryTranscriptCapture(capture) : await capture();
  } catch (err) {
    console.warn(
      `[transcript-mirror] capture failed for session ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
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
 * So a settled outcome (flag off, already whole, or a capture that returned a
 * result) is recorded as done and never retried; an attempt that could not run
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
 * means a project that enables `session_transcript_history` gets NOTHING for
 * its existing sessions: the mirror for each one stays empty until somebody
 * happens to send it another message. Opening the session — the exact moment
 * the user is waiting and the feature is supposed to pay off — wrote nothing,
 * so the second open was as blank as the first.
 *
 * So: the first time a flagged session's runtime is up, mirror what is already
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
 * mirror (pruned by legacy retention) merges the head back rather than
 * trimming — which is the repair this is for.
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
          metadata: projects.metadata,
          root: projectSessions.opencodeSessionId,
          mirrorRoot: sessionTranscriptMirrors.opencodeSessionId,
          headComplete: sessionTranscriptMirrors.headComplete,
        })
        .from(projectSessions)
        .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
        .leftJoin(
          sessionTranscriptMirrors,
          eq(sessionTranscriptMirrors.sessionId, projectSessions.sessionId),
        )
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      // No such session. Nothing will ever change that.
      if (!row) return settle();
      // Off ⇒ the surface stays dark and so does this. A legacy tail mirror is
      // still maintained at turn end exactly as before.
      if (!resolveFeatureFlag(row.metadata, 'session_transcript_history')) return settle();
      // Already whole, for the root this session actually runs. Nothing a
      // backfill could add — a re-pinned root is NOT whole, whatever the row says.
      if (row.headComplete && row.mirrorRoot && row.mirrorRoot === row.root) return settle();
      // A RESULT settles it; null means the read could not run (no pinned root
      // yet, box not reachable) and the next open is allowed to try again.
      if (await captureSessionTranscriptMirror(sessionId, deps)) settle();
    } catch (err) {
      console.warn(
        `[transcript-mirror] wake backfill failed for session ${sessionId}:`,
        err instanceof Error ? err.message : err,
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

/** Retention. Deleting the head is exactly what `head_complete` records, so
 *  a prune that removes anything clears it. */
async function pruneSessionTranscriptMirror(
  sessionId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<number> {
  const deleted = await tx.execute(sql`
    DELETE FROM kortix.session_transcript_messages
    WHERE session_id = ${sessionId}
      AND message_id NOT IN (
        SELECT message_id FROM kortix.session_transcript_messages
        WHERE session_id = ${sessionId}
        ORDER BY message_created_at DESC NULLS LAST, message_id DESC
        LIMIT ${MIRROR_MAX_MESSAGES}
      )
    RETURNING message_id
  `);
  const rows = Array.isArray(deleted) ? deleted : ((deleted as { rows?: unknown[] }).rows ?? []);
  if (rows.length > 0) {
    await tx
      .update(sessionTranscriptMirrors)
      .set({ headComplete: false, updatedAt: new Date() })
      .where(eq(sessionTranscriptMirrors.sessionId, sessionId));
  }
  return rows.length;
}
