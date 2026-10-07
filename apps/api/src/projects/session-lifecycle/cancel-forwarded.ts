/**
 * Cancelling a prompt that is already AT OpenCode but not yet reached.
 *
 * "Forwarded" used to be the point of no return: `DELETE .../prompts/:id`
 * answered 409 the moment the drain handed the message over, which — with the
 * drain forwarding within ~1 s of Enter — meant the queue's Remove button
 * existed for about a second per prompt. But a forwarded prompt the loop has
 * not READ is still only text in the runtime's transcript, and it can be
 * taken back out:
 *
 *  - box idle → `DELETE /session/:id/message/:mid` removes it whole;
 *  - box mid-turn → that route is refused (`assertNotBusy`), but
 *    `DELETE …/part/:pid` is not, and a user message with ZERO parts is
 *    skipped by `toModelMessages` (`if (msg.parts.length === 0) continue`) —
 *    the model never sees it, the loop's id-order bookkeeping is untouched.
 *
 * A prompt the loop HAS reached (an assistant answers it, or a step parented
 * on it/newer read it) stays: that is "already being answered", and the 409
 * remains truthful for it.
 */

import { sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { isPgBroadcastListening, waitForLifecycleCommandSettle } from '../../shared/pg-broadcast';
import { closeSandboxTurnByMessageId } from '../sandbox-turn-lifecycle';
import { deleteRuntimeMessage, readSessionMessageTip, removeRuntimeMessage, resolveSessionOpencodeEndpoint } from './runtime-client';
import { sessionRuntimeFetch } from './runtime-fetch';
import { legacyRuntimePaths } from './legacy-runtime-rest';
import { reachedPlacement, strandedPlacement, type PlacementTipMessage } from './forwarded-placement';
import { deleteInboxRowsWithAttachmentGrace, inboxScope } from './inbox-rows';
import { wireMessageIdMatches } from './wire-id-match';

function isOnWire(result: unknown): boolean {
  const status = (result as { status?: unknown } | null)?.status;
  return status === 'forwarded' || status === 'delivered';
}
import type { SessionLifecycleCommandRow } from './store';

const TIP_LIMIT = 30;
const SETTLE_BUDGET_MS = 3_200;
const POLL_FALLBACK_MS = 400;

export type CancelForwardedOutcome =
  | { outcome: 'cancelled'; row: SessionLifecycleCommandRow }
  | { outcome: 'answered' }
  | { outcome: 'unreachable' }
  | { outcome: 'not_forwarded' };

/** Find the newest inbox row that ever carried this wire/message id — the
 *  client's handle once the row left the prompt list (confirmed `delivered`
 *  on persistence, long before the model reads it). */
export async function findInboxRowIdByMessageId(
  sessionId: string,
  messageId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(and(inboxScope(sessionId), wireMessageIdMatches(messageId)))
    .orderBy(desc(sessionLifecycleCommands.createdAt))
    .limit(1);
  return row?.commandId ?? null;
}

export async function cancelForwardedPrompt(
  sessionId: string,
  promptId: string,
): Promise<CancelForwardedOutcome> {
  // A row the drain has CLAIMED settles into `forwarded` within ~1.5 s (one
  // proxied POST). The click that races that window waits it out rather than
  // refusing — from the user's side the prompt is equally "queued" either way.
  // It waits on the settle itself (a NOTIFY from any replica), re-reading the
  // row on each wake; without the LISTEN it re-reads every 400 ms as before.
  let row: SessionLifecycleCommandRow | undefined;
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  for (;;) {
    const settle = waitForLifecycleCommandSettle(
      promptId,
      isPgBroadcastListening() ? deadline - Date.now() : POLL_FALLBACK_MS,
    );
    const [found] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(and(eq(sessionLifecycleCommands.commandId, promptId), inboxScope(sessionId)))
      .limit(1);
    if (found?.status === 'running' && Date.now() < deadline) {
      await settle.done;
      continue;
    }
    settle.cancel();
    if (!found) return { outcome: 'not_forwarded' };
    // ON THE WIRE: forwarded, or already confirmed `delivered` — the daemon's
    // acceptance relay confirms on PERSISTENCE (~1 s after delivery), long
    // before any model step reads the message. The tip read below is what
    // decides "actually being answered".
    if (found.status === 'succeeded' && isOnWire(found.result)) row = found as SessionLifecycleCommandRow;
    // `queued`/`failed`: fell back into the queue while we watched — the plain
    // delete path owns it again. Anything else is not on the wire either.
    else if (found.status !== 'running') return { outcome: 'not_forwarded' };
    break;
  }
  if (!row) {
    logger.warn('[cancel-forwarded] row never settled out of running', { session_id: sessionId, prompt_id: promptId });
    return { outcome: 'unreachable' };
  }
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const result = (row.result ?? {}) as Record<string, unknown>;
  const targetIds = [result.forwarded_message_id, payload.redeliveredMessageId, payload.wireMessageId]
    .filter((id, i, all): id is string => typeof id === 'string' && !!id && all.indexOf(id) === i);
  if (targetIds.length === 0) return { outcome: 'not_forwarded' };

  const resolved = await resolveSessionOpencodeEndpoint(sessionId, row.actorUserId);
  if (!resolved) {
    logger.warn('[cancel-forwarded] endpoint unresolved', { session_id: sessionId, prompt_id: promptId });
    return { outcome: 'unreachable' };
  }

  let tip: PlacementTipMessage[] | null;
  try {
    tip = await readSessionMessageTip(resolved, { limit: TIP_LIMIT });
  } catch (err) {
    logger.warn('[cancel-forwarded] tip read threw', { session_id: sessionId, error: err instanceof Error ? err.message : String(err) });
    return { outcome: 'unreachable' };
  }
  if (!tip) {
    logger.warn('[cancel-forwarded] tip read unavailable', { session_id: sessionId });
    return { outcome: 'unreachable' };
  }

  const present = tip.filter((m) => targetIds.includes(m.id));
  for (const id of targetIds) {
    const verdict = strandedPlacement(tip, id);
    // Answered, or a step has read it (it is being answered right now).
    if (verdict.answered) return { outcome: 'answered' };
    if (!verdict.stranded && reachedPlacement(tip, id)) return { outcome: 'answered' };
  }

  // A STEER pi has not read is in no transcript: kortixd holds it in front of
  // the turn and publishes it when the turn reads it. Only its DELETE takes it
  // back: 2xx removed, 404 gone, 409 read (R10).
  if (present.length === 0 && typeof result.steered_into_message_id === 'string') {
    for (const id of targetIds) {
      let status: number;
      try {
        status = (await deleteRuntimeMessage(resolved, id)).status;
      } catch {
        return { outcome: 'unreachable' };
      }
      if (status === 409) return { outcome: 'answered' };
      if (status >= 300 && status !== 404) return { outcome: 'unreachable' };
    }
  }

  // Take the copies out. Whole-message first (works while idle); when the
  // loop is busy that route is refused — empty the message part by part
  // instead, which the model then never sees.
  for (const message of present) {
    let removed = false;
    try {
      removed = await removeRuntimeMessage(resolved, message.id);
    } catch {
      removed = false;
    }
    if (removed) continue;
    for (const partId of message.partIds ?? []) {
      try {
        const res = await sessionRuntimeFetch(
          resolved.endpoint,
          'DELETE',
          legacyRuntimePaths.part(resolved.opencodeSessionId, message.id, partId),
        );
        if (!res.ok && res.status !== 404) {
          logger.warn('[cancel-forwarded] part delete refused', {
            session_id: sessionId,
            message_id: message.id,
            part_id: partId,
            upstream_status: res.status,
          });
          return { outcome: 'unreachable' };
        }
      } catch {
        return { outcome: 'unreachable' };
      }
    }
  }

  // The runtime no longer holds it: the row goes, and its turn authority with
  // it. Guarded on status so a concurrent consumption cannot be deleted from
  // under its own confirmation.
  const deleted = await deleteInboxRowsWithAttachmentGrace(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        eq(sessionLifecycleCommands.status, 'succeeded'),
      ),
    );
  if (!deleted[0]) return { outcome: 'answered' };
  for (const id of targetIds) {
    await closeSandboxTurnByMessageId(sessionId, id, 'abandoned').catch(() => undefined);
  }
  logger.info('[cancel-forwarded] forwarded prompt cancelled', {
    session_id: sessionId,
    prompt_id: promptId,
    message_ids: targetIds,
  });
  return { outcome: 'cancelled', row: deleted[0] as SessionLifecycleCommandRow };
}
