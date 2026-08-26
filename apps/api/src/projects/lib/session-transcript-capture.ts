/**
 * Writing the durable transcript mirror.
 *
 * SPLIT ON PURPOSE. Capture needs `resolveSessionOpencodeEndpoint`, which lives
 * in the session-lifecycle engine and pulls most of the control plane in behind
 * it. The transcript digest only READS the mirror and must not carry that
 * graph — `session-transcript.ts` therefore imports the sibling read module and
 * `routes/r4.ts` is the only importer of this one. (Concretely: without the
 * split, `unit-session-transcript.test.ts`'s `../shared/db` mock stopped
 * satisfying the engine's own imports and the whole file failed to load.)
 *
 * The rationale for capturing at TURN END — and the identity/attachment-bytes
 * rules the writer enforces — lives in `session-transcript-mirror.ts`'s header.
 */

import { projectSessions, sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
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
  ) => Promise<{ opencodeSessionId: string; payload: unknown } | null>;
}

const liveCaptureDeps: CaptureDeps = {
  async readMessages(sessionId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return null;
    const url = new URL(
      `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message`,
    );
    url.searchParams.set('directory', WORKSPACE_DIRECTORY);
    url.searchParams.set('limit', String(MIRROR_CAPTURE_LIMIT));
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return {
      opencodeSessionId: resolved.opencodeSessionId,
      payload: await res.json().catch(() => null),
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
 * Read the box once and upsert what it said into the mirror.
 *
 * NEVER THROWS. Every caller is a fire-and-forget hook on a relay the daemon
 * retries; a mirror write must not be able to fail a turn-end report.
 */
export async function captureSessionTranscriptMirror(
  sessionId: string,
  deps: CaptureDeps = liveCaptureDeps,
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

    const read = await deps.readMessages(sessionId);
    if (!read) return null;
    const rows = mirrorRowsFromOpencodePayload(read.payload);
    if (rows.length === 0) return null;

    const [existing] = await db
      .select({
        headComplete: sessionTranscriptMirrors.headComplete,
        opencodeSessionId: sessionTranscriptMirrors.opencodeSessionId,
      })
      .from(sessionTranscriptMirrors)
      .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
      .limit(1);

    // A re-pinned root (a restarted box adopting a different OpenCode session)
    // makes every previously mirrored id unreachable from the new thread.
    // Keeping them would serve a transcript the live read can never settle
    // against — the ghost case. Drop them and start the head bit over.
    const rootChanged =
      !!existing?.opencodeSessionId && existing.opencodeSessionId !== read.opencodeSessionId;
    const headComplete = headCompleteAfterCapture({
      returned: rows.length,
      limit: MIRROR_CAPTURE_LIMIT,
      previous: rootChanged ? false : (existing?.headComplete ?? false),
    });

    const now = new Date();
    await db.transaction(async (tx) => {
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

      if (rootChanged) {
        await tx
          .delete(sessionTranscriptMessages)
          .where(eq(sessionTranscriptMessages.sessionId, sessionId));
      }

      for (const row of rows) {
        const values = {
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
        };
        await tx
          .insert(sessionTranscriptMessages)
          .values(values)
          .onConflictDoUpdate({
            target: [sessionTranscriptMessages.sessionId, sessionTranscriptMessages.messageId],
            set: {
              parentMessageId: values.parentMessageId,
              opencodeSessionId: values.opencodeSessionId,
              role: values.role,
              messageCreatedAt: values.messageCreatedAt,
              messageCompletedAt: values.messageCompletedAt,
              info: values.info,
              parts: values.parts,
              capturedAt: values.capturedAt,
            },
          });
      }
    });

    const pruned = await pruneSessionTranscriptMirror(sessionId);
    return { captured: rows.length, head_complete: headComplete && pruned === 0, pruned };
  } catch (err) {
    console.warn(
      `[transcript-mirror] capture failed for session ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Retention. Deleting the head is exactly what `head_complete` records, so
 *  a prune that removes anything clears it. */
async function pruneSessionTranscriptMirror(sessionId: string): Promise<number> {
  const deleted = await db.execute(sql`
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
    await db
      .update(sessionTranscriptMirrors)
      .set({ headComplete: false, updatedAt: new Date() })
      .where(eq(sessionTranscriptMirrors.sessionId, sessionId));
  }
  return rows.length;
}
