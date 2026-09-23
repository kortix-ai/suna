/**
 * Finishing a Remove the runtime could only half-do.
 *
 * `cancelForwardedPrompt` takes an unread prompt back out of the runtime. While
 * the loop is idle it deletes the whole message. While the loop is running,
 * OpenCode refuses that route (`DELETE /session/:id/message/:mid` answers 409 —
 * `assertNotBusy`), and the only thing it allows is deleting the message's
 * parts one by one. The model never sees a part-less user message
 * (`toModelMessages` skips it), but the message itself stays: measured
 * 2026-09-23 on a 40 s tool loop, the husk remained after the turn ended, and
 * the loop's final answer was parented ON it — OpenCode's loop takes the
 * newest user message as the parent of its next step, empty or not. After a
 * reload, every client drew it as an empty turn with only a timestamp.
 *
 * So the emptied id is RECORDED on the session's box row, and the turn-end
 * relay — the moment the loop goes idle and the delete is allowed — deletes it
 * (`reconcileForwardedTurnsAtEnd`). Durable on purpose: the API restarts far
 * more often than a long tool loop ends. The answer that was parented on the
 * husk keeps a dangling `parentID`; every client groups such an assistant with
 * the turn before it, which is where it belongs — the prompt it pointed at was
 * removed by the user.
 */

import { sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { resolveSessionOpencodeEndpoint } from './engine';

const KEY = 'pendingHuskMessageIds';
const WORKSPACE = '/workspace';

export type HuskDeleteOutcome = 'deleted' | 'busy' | 'unreachable';

export interface HuskSweepDeps {
  deleteMessage: (sessionId: string, messageId: string) => Promise<HuskDeleteOutcome>;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? result) as Array<
    Record<string, unknown>
  >;
}

/** Add message ids to the session's pending husks (a set: no duplicates). */
export async function recordPendingHusks(sessionId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`
    UPDATE kortix.session_sandboxes
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             ${KEY}::text,
             (SELECT COALESCE(jsonb_agg(DISTINCT id ORDER BY id), '[]'::jsonb)
                FROM jsonb_array_elements_text(
                       COALESCE(metadata->${KEY}::text, '[]'::jsonb) || ${JSON.stringify(ids)}::jsonb
                     ) AS id))
     WHERE session_id = ${sessionId}`);
}

/** The session's pending husk ids, oldest record first. */
export async function readPendingHusks(sessionId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT metadata->${KEY}::text AS ids
      FROM kortix.session_sandboxes
     WHERE session_id = ${sessionId}
     LIMIT 1`);
  const ids = rowsOf(result)[0]?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

async function forgetPendingHusk(sessionId: string, messageId: string): Promise<void> {
  await db.execute(sql`
    UPDATE kortix.session_sandboxes
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             ${KEY}::text,
             COALESCE(metadata->${KEY}::text, '[]'::jsonb) - ${messageId}::text)
     WHERE session_id = ${sessionId}`);
}

const liveDeps: HuskSweepDeps = {
  async deleteMessage(sessionId, messageId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return 'unreachable';
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok || res.status === 404) return 'deleted';
      // 409 is the busy loop (`assertNotBusy`); any other refusal is kept too,
      // so a later turn end asks again.
      return res.status === 409 ? 'busy' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  },
};

/**
 * Delete every recorded husk the runtime will let go of now. A busy or
 * unreachable runtime keeps the id for the next turn end.
 */
export async function sweepPendingHusks(
  sessionId: string,
  deps: HuskSweepDeps = liveDeps,
): Promise<{ deleted: number; pending: number }> {
  const ids = await readPendingHusks(sessionId);
  let deleted = 0;
  for (const id of ids) {
    const outcome = await deps.deleteMessage(sessionId, id);
    if (outcome !== 'deleted') continue;
    await forgetPendingHusk(sessionId, id);
    deleted += 1;
    logger.info('[husk-cleanup] emptied prompt deleted from the runtime', {
      session_id: sessionId,
      message_id: id,
    });
  }
  return { deleted, pending: ids.length - deleted };
}
