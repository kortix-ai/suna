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
    );
    return {
      opencodeSessionId: resolved.opencodeSessionId,
      payload: result.rows,
      headComplete: result.headComplete,
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

    const fullHistory = resolveFeatureFlag(session.metadata, 'session_transcript_history');
    const retainHistory =
      fullHistory || session.metadata?.session_transcript_history_retained === true;
    const capture = async (): Promise<CaptureResult | null> => {
      const startedAt = new Date();
      const read = await deps.readMessages(sessionId, {
        fullHistory,
        projectId: session.projectId,
        retainHistory,
      });
      if (!read) return null;
      const rows = mirrorRowsFromOpencodePayload(read.payload);
      if (rows.length === 0 && !fullHistory) return null;
      if (fullHistory && read.headComplete !== true) return null;

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
        const headComplete = fullHistory
          ? read.headComplete === true
          : headCompleteAfterCapture({
              returned: rows.length,
              limit: MIRROR_CAPTURE_LIMIT,
              previous: rootChanged ? false : (existing?.headComplete ?? false),
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

        if (fullHistory && !session.metadata?.session_transcript_history_retained) {
          await tx
            .update(projects)
            .set({
              metadata: sql`jsonb_set(COALESCE(${projects.metadata}, '{}'::jsonb), '{session_transcript_history_retained}', 'true'::jsonb)`,
            })
            .where(eq(projects.projectId, session.projectId));
        }

        if (rootChanged || fullHistory) {
          await tx
            .delete(sessionTranscriptMessages)
            .where(eq(sessionTranscriptMessages.sessionId, sessionId));
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

const captures = new Map<string, Promise<CaptureResult | null>>();

export function captureSessionTranscriptMirror(
  sessionId: string,
  deps: CaptureDeps = liveCaptureDeps,
): Promise<CaptureResult | null> {
  const previous = captures.get(sessionId) ?? Promise.resolve(null);
  const pending = previous.then(() => captureSessionTranscript(sessionId, deps));
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
