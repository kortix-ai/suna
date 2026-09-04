/**
 * What a Stop means for prompts that were already ON THE WIRE.
 *
 * `holdInboxPrompts(sessionId, true)` is instant and purely a marking: queued
 * rows become held, forwarded rows become stop-paused, a row the drain has
 * CLAIMED gets a payload flag its delivery consumes. The client aborts the box
 * right after. Two things that marking cannot do are done here, after the hold
 * route has answered, because each needs the box:
 *
 *  1. A CLAIMED row's POST can land AFTER the abort. OpenCode's runner is idle
 *     by then, so that prompt starts a fresh loop — the agent visibly restarts
 *     on a message the user queued BEFORE pressing Stop (measured, `queue-lab`
 *     `stop_hold`: abort at 48.367, next prompt persisted 48.397, new loop at
 *     48.425, full answer streamed). This waits for claimed rows to settle and,
 *     if the box is mid-step afterwards, aborts it once more.
 *
 *  2. A forwarded prompt the loop never READ is still only text in the
 *     transcript. It is taken back out of OpenCode and becomes an ordinary HELD
 *     row — "Held — stopped", with Send now / Remove — instead of the
 *     previous "stop-paused" limbo whose release re-delivered the prompt while
 *     OpenCode still held the original, unanswered (the documented duplicate in
 *     inbox-rows.ts). A forwarded prompt the loop DID read belongs to the turn
 *     the abort ended: it stays in the transcript as part of that interrupted
 *     turn (the runtime answers it with the next send) and its row closes as
 *     delivered, so a release cannot send it a second time.
 *
 * Best-effort end to end: a box that cannot be read leaves the rows exactly
 * as the instant hold marked them, which is the pre-existing behaviour.
 *
 * THE CONTRACT A STOP HAS WITH A QUEUED PROMPT
 *
 * Stop pauses the queue; it never throws a prompt away and never runs one
 * behind the user's back. Every prompt the Stop caught ends up in exactly one
 * of three states, and each of them delivers AT MOST ONCE more:
 *
 *  - HELD (`queued`, `result.held`) — the ordinary outcome. The prompt is on
 *    screen as "Held — stopped" with Send now / Remove.
 *  - DELIVERED — the aborted step had already read it, so it belongs to the
 *    interrupted turn and no release may send it again.
 *  - REMOVED — the user deleted the row.
 *
 * A hold is lifted by an ACTION, never by a timer: sending anything new
 * (`POST .../prompts` → `releaseInboxHold`), "send now" on one row
 * (`retryInboxPrompt`), or Resume (`POST .../prompts/hold {held:false}`).
 * `INBOX_HOLD_MS` (24 h) is a horizon, not a scheduler — it exists so a browser
 * that never comes back cannot hold a prompt for ever.
 *
 * "Delivers at most once more" is what step 3 below buys. Without it a held
 * forwarded row is released straight back onto the queue while OpenCode still
 * holds the copy it was POSTed as, and the re-mint puts a SECOND user message
 * with the same text into the transcript.
 */

import { sessionLifecycleCommands } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { closeSandboxTurnByMessageId } from '../sandbox-turn-lifecycle';
import { resolveSessionOpencodeEndpoint } from './engine';
import {
  type PlacementTipMessage,
  parsePlacementTip,
  reachedPlacement,
  tipIsBusy,
} from './forwarded-placement';
import { INBOX_HOLD_MS, inboxScope } from './inbox-rows';
import { withNextDeliveryAttempt } from './store';

const WORKSPACE = '/workspace';
const TIP_LIMIT = 16;
/** How long a claimed delivery is given to land after the hold. A delivery is
 *  one proxied POST (~0.3–1.5 s); the drain's own retry budget is far longer,
 *  but a prompt that is still in flight after this is not going to land into
 *  the turn the user stopped. */
const CLAIMED_SETTLE_MS = 3_000;
const CLAIMED_POLL_MS = 100;
/**
 * The rows this settle is about: one prompt of THIS session that has been
 * POSTed to OpenCode and is not finished.
 *
 * ON THE WIRE is two `result.status` values, not one. `forwarded` is what
 * `markCommandForwarded` writes when the POST lands; `delivered` is what the
 * daemon's acceptance relay writes when OpenCode PERSISTS the message, which
 * happens long before any step reads it — so a `delivered` row is just as
 * likely to be unreached by a Stop. Only recent ones: an old delivered row is
 * history.
 *
 * IT DOES NOT EXCLUDE `result.held`, and that is the whole point. The hold
 * route runs `holdInboxPrompts(sessionId, true)` — which stamps every
 * forwarded row `{stop_paused: true, held: true}` — and THEN starts this
 * settle. Excluding held rows therefore excluded exactly the rows the Stop had
 * just paused: the ones this module exists to take back out of OpenCode. Their
 * copy stayed in the transcript, the release re-POSTed the prompt under a
 * re-minted wire id, and the user saw the same prompt twice — once unanswered,
 * once answered (the "KNOWN COST" documented in `holdInboxPrompts`). The
 * exclusion was invisible to the unit tests because every one of them stubs
 * `listStopPaused`; see the compiled-SQL test that now pins it.
 *
 * A row that is `queued` and held (this settle's own `holdAsQueued` outcome,
 * or a prompt that never went out) is still excluded — by `status`
 * (`succeeded`) and by `result.status`, not by the held marker.
 */
export function stopPausedOnWireScope(sessionId: string) {
  return and(
    inboxScope(sessionId),
    eq(sessionLifecycleCommands.status, 'succeeded'),
    sql`${sessionLifecycleCommands.result}->>'status' IN ('forwarded', 'delivered')`,
    sql`(${sessionLifecycleCommands.result}->>'forwarded_at')::timestamptz > now() - interval '10 minutes'`,
  );
}

export interface StopPausedRow {
  commandId: string;
  /** Every id this row was ever posted under, newest last. */
  wireIds: string[];
}

export interface HoldSettleDeps {
  countClaimed: (sessionId: string) => Promise<number>;
  listStopPaused: (sessionId: string) => Promise<StopPausedRow[]>;
  readTip: (sessionId: string) => Promise<PlacementTipMessage[] | null>;
  abort: (sessionId: string) => Promise<boolean>;
  removeMessage: (sessionId: string, messageId: string) => Promise<boolean>;
  /** Forwarded + stop-paused → plain queued + held (deliverable on release). */
  holdAsQueued: (commandId: string) => Promise<void>;
  /** Forwarded + stop-paused → delivered (the interrupted turn owns it). */
  closeDelivered: (commandId: string) => Promise<void>;
  /** The turn-ledger record opened for a wire id that was taken back out. */
  closeTurn: (sessionId: string, messageId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const liveDeps: HoldSettleDeps = {
  async countClaimed(sessionId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionLifecycleCommands)
      .where(and(inboxScope(sessionId), eq(sessionLifecycleCommands.status, 'running')));
    return Number(row?.n ?? 0);
  },
  async listStopPaused(sessionId) {
    const rows = await db
      .select({
        commandId: sessionLifecycleCommands.commandId,
        wire: sql<string | null>`${sessionLifecycleCommands.payload}->>'wireMessageId'`,
        redelivered: sql<string | null>`${sessionLifecycleCommands.payload}->>'redeliveredMessageId'`,
        forwarded: sql<string | null>`${sessionLifecycleCommands.result}->>'forwarded_message_id'`,
      })
      .from(sessionLifecycleCommands)
      .where(stopPausedOnWireScope(sessionId));
    return rows.map((row) => ({
      commandId: row.commandId,
      wireIds: [row.wire, row.redelivered, row.forwarded].filter(
        (id, i, all): id is string => typeof id === 'string' && id.length > 0 && all.indexOf(id) === i,
      ),
    }));
  },
  async readTip(sessionId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return null;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message?directory=${encodeURIComponent(WORKSPACE)}&limit=${TIP_LIMIT}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return parsePlacementTip(await res.json().catch(() => null));
  },
  async abort(sessionId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return false;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/abort?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  },
  async removeMessage(sessionId, messageId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return false;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok || res.status === 404;
  },
  async holdAsQueued(commandId) {
    await db
      .update(sessionLifecycleCommands)
      .set({
        status: 'queued',
        availableAt: new Date(Date.now() + INBOX_HOLD_MS),
        attempts: 0,
        lockedBy: null,
        lockedUntil: null,
        // The delivery markers go; `held` stays. `remintOnDelivery` was
        // stamped by the hold, so the release re-places it above the
        // transcript it lands in.
        result: { held: true },
        payload: withNextDeliveryAttempt(
          sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, commandId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
          sql`${sessionLifecycleCommands.result}->>'status' IN ('forwarded', 'delivered')`,
        ),
      );
  },
  async closeDelivered(commandId) {
    await db
      .update(sessionLifecycleCommands)
      .set({
        result: sql`(COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) || '{"status": "delivered"}'::jsonb) - 'stop_paused' - 'held'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, commandId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
          sql`${sessionLifecycleCommands.result}->>'status' IN ('forwarded', 'delivered')`,
        ),
      );
  },
  async closeTurn(sessionId, messageId) {
    await closeSandboxTurnByMessageId(sessionId, messageId, 'abandoned');
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface HoldSettlement {
  waitedMs: number;
  claimedLeft: number;
  reAborted: boolean;
  heldBack: number;
  closedAsInterrupted: number;
  unreadable: boolean;
}

export async function settleInboxHoldAfterStop(
  sessionId: string,
  deps: HoldSettleDeps = liveDeps,
): Promise<HoldSettlement> {
  const out: HoldSettlement = {
    waitedMs: 0,
    claimedLeft: 0,
    reAborted: false,
    heldBack: 0,
    closedAsInterrupted: 0,
    unreadable: false,
  };
  // 1. Let claimed deliveries land (or give up on them).
  const started = deps.now();
  let claimed = await deps.countClaimed(sessionId);
  while (claimed > 0 && deps.now() - started < CLAIMED_SETTLE_MS) {
    await deps.sleep(CLAIMED_POLL_MS);
    claimed = await deps.countClaimed(sessionId);
  }
  out.waitedMs = deps.now() - started;
  out.claimedLeft = claimed;

  const stopPaused = await deps.listStopPaused(sessionId);
  if (stopPaused.length === 0 && claimed === 0) return out;

  // 2. One look at the box.
  let tip = await deps.readTip(sessionId);
  if (!tip) {
    out.unreadable = true;
    return out;
  }
  // A prompt that landed after the abort restarted the loop: stop it again.
  if (tipIsBusy(tip)) {
    out.reAborted = await deps.abort(sessionId);
    if (out.reAborted) {
      await deps.sleep(250);
      tip = (await deps.readTip(sessionId)) ?? tip;
    }
  }

  // 3. Settle every stop-paused row by what the loop did with it.
  for (const row of stopPaused) {
    const ids = row.wireIds;
    if (ids.length === 0) continue;
    const reached = ids.some((id) => reachedPlacement(tip!, id));
    if (reached) {
      await deps.closeDelivered(row.commandId);
      out.closedAsInterrupted += 1;
      continue;
    }
    // Unreached: take the copies out of the transcript, then hold the row.
    // If a copy cannot be removed the row stays stop-paused — the old,
    // duplicating-but-never-losing path.
    let removedAll = true;
    for (const id of ids) {
      const present = tip.some((m) => m.id === id);
      if (!present) continue;
      if (!(await deps.removeMessage(sessionId, id))) removedAll = false;
    }
    if (!removedAll) continue;
    await deps.holdAsQueued(row.commandId);
    // The turn authority opened for this delivery must not keep the session
    // reading as working: nothing is running this prompt any more.
    for (const id of ids) {
      try {
        await deps.closeTurn(sessionId, id);
      } catch (err) {
        logger.warn('[inbox-hold] could not close the ledger turn of a held-back prompt', {
          session_id: sessionId,
          message_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    out.heldBack += 1;
  }
  return out;
}

/** Fire-and-forget entry for the hold route. */
export function settleInboxHoldAfterStopInBackground(sessionId: string): void {
  void settleInboxHoldAfterStop(sessionId)
    .then((result) => {
      if (result.reAborted || result.heldBack || result.closedAsInterrupted || result.claimedLeft) {
        logger.info('[inbox-hold] settled after stop', { session_id: sessionId, ...result });
      }
    })
    .catch((err) =>
      logger.warn('[inbox-hold] settle after stop failed', {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}
