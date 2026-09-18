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

import { projectSessions, sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { logger } from '../../lib/logger';
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

/**
 * Waits before re-reading the box for a capture that did not land.
 *
 * A capture runs once per turn end and nothing else retries it, so a single bad
 * moment — a box saturated by the turn it just finished, a proxy 503 mid-swap,
 * an endpoint that resolves a beat late — used to freeze the mirror for the
 * life of the session. The client then seeds a reload from that frozen copy.
 * Two retries cover that window without holding the relay: the caller is
 * fire-and-forget.
 */
export const CAPTURE_RETRY_DELAYS_MS = [500, 2_000] as const;

export interface CaptureResult {
  captured: number;
  head_complete: boolean;
  pruned: number;
}

interface CaptureLogger {
  warn: (message: string, context: Record<string, unknown>) => void;
}

export interface CaptureDeps {
  readMessages: (
    sessionId: string,
  ) => Promise<{ opencodeSessionId: string; payload: unknown } | null>;
  /** Seams for the retry test: production uses the real clock and logger. */
  sleep?: (ms: number) => Promise<void>;
  logger?: CaptureLogger;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read the box for a capture, retrying a read that did not answer.
 *
 * A read that throws is a failed read like any other: this never propagates, so
 * a turn-end relay cannot fail on it. An exhausted read is reported once —
 * silence here is what made a frozen mirror invisible.
 */
export async function readCaptureMessages(
  sessionId: string,
  deps: CaptureDeps,
): Promise<{ opencodeSessionId: string; payload: unknown } | null> {
  const sleep = deps.sleep ?? wait;
  const log = deps.logger ?? logger;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= CAPTURE_RETRY_DELAYS_MS.length; attempt += 1) {
    const read = await deps.readMessages(sessionId).catch((err: unknown) => {
      lastError = err;
      return null;
    });
    if (read) return read;
    if (attempt < CAPTURE_RETRY_DELAYS_MS.length) await sleep(CAPTURE_RETRY_DELAYS_MS[attempt]);
  }
  log.warn('[transcript-mirror] capture read never landed; the mirror stays as it was', {
    sessionId,
    attempts: CAPTURE_RETRY_DELAYS_MS.length + 1,
    ...(lastError ? { error: lastError instanceof Error ? lastError.message : String(lastError) } : {}),
  });
  return null;
}

const liveCaptureDeps: CaptureDeps = {
  async readMessages(sessionId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) {
      logger.warn('[transcript-mirror] capture read skipped: no OpenCode endpoint', { sessionId });
      return null;
    }
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
    if (!res.ok) {
      logger.warn('[transcript-mirror] capture read refused by the box', {
        sessionId,
        status: res.status,
      });
      return null;
    }
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
 * NEVER THROWS. Turn-end reports start capture asynchronously. Manual stop
 * awaits capture before powering off; a mirror failure must not prevent stop.
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

    const read = await readCaptureMessages(sessionId, deps);
    if (!read) return null;
    const rows = mirrorRowsFromOpencodePayload(read.payload);
    if (rows.length === 0) {
      logger.warn('[transcript-mirror] capture read carried no messages', { sessionId });
      return null;
    }

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
