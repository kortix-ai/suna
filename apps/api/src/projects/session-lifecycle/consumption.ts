import { sessionLifecycleCommands, sessionTurns } from '@kortix/db';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { DEDUPE_TTL_MS } from '../../sandbox-proxy/prompt-dedupe';
import { db } from '../../shared/db';
import { PROMPT_NEVER_RAN_END_REASONS } from './redelivery';
import { wireMessageIdMatches } from './wire-id-match';

/**
 * The other end of a FORWARDED prompt.
 *
 * `markCommandForwarded` leaves the row open on purpose: handing a prompt to
 * OpenCode is not the same as OpenCode running it. OpenCode persists the user
 * message and queues its execution behind whatever turn is in flight, so the
 * only thing that can say the prompt was actually consumed is the
 * `kortix.session_turns` ledger naming its wire id. Until then the row keeps
 * reading `delivering`, which is what holds the composer's working state.
 *
 * Two shapes close a row, and neither of them delivers anything:
 *  - a WITNESS — the ledger's own accept/complete writes, keyed by wire id;
 *  - the BOUND — `reconcileForwardedPrompts`, so a witness that never arrives
 *    cannot strand a row as `delivering` for ever.
 */

/**
 * How long a forwarded row is left entirely alone.
 *
 * The same window the reaper uses for "accepted, but not started yet"
 * (`ORPHANED_PROMPT_MIN_AGE_MS`): inside it, a missing ledger row is ordinary
 * — acceptance is a second round trip after the delivery, and the sweep must
 * not race the witness it exists to back up.
 */
export const INBOX_FORWARD_CONFIRM_GRACE_MS = 30_000;

/**
 * When "we still cannot tell" stops being worth preserving.
 *
 * Derived from the proxy's delivery-claim TTL, not hardcoded a second time:
 * past this window the claim that would absorb a duplicate POST has expired
 * anyway, so nothing downstream is protected by keeping the row open. Every
 * ledger write is a best-effort SECOND round trip whose failure
 * `recordTurnLedger` swallows, so "no ledger row" proves nothing — and a strip
 * that says `delivering` for ever is worse than a logged unknown.
 */
export const INBOX_FORWARD_CONFIRM_MAX_MS = DEDUPE_TTL_MS;

const FORWARDED_SCAN_BATCH = 25;

/** One `succeeded` + forwarded row, as the sweep needs to read it. */
export interface ForwardedPromptRow {
  commandId: string;
  sessionId: string;
  wireMessageId: string | null;
  redeliveredMessageId: string | null;
  updatedAt: Date;
}

/** What the ledger says about the turn that carried one wire id. */
export interface LedgerTurnState {
  state: string;
  endReason: string | null;
}

export interface ConsumptionDeps {
  /** Close every forwarded row of this session that this wire id names.
   *  Returns how many rows changed. */
  confirm: (sessionId: string, wireMessageId: string) => Promise<number>;
  /** Record the consumption on a row the drain is STILL DELIVERING, for
   *  `markCommandForwarded` to land. Returns how many rows changed. */
  markConsumedOnDelivery: (sessionId: string, wireMessageId: string) => Promise<number>;
  listForwarded: (olderThan: Date, limit: number) => Promise<ForwardedPromptRow[]>;
  readLedgerTurn: (sessionId: string, messageIds: string[]) => Promise<LedgerTurnState | null>;
  logForceClosed: (message: string, context: Record<string, unknown>) => void;
}

const liveDeps: ConsumptionDeps = {
  async confirm(sessionId, wireMessageId) {
    const rows = await db
      .update(sessionLifecycleCommands)
      .set({
        // MERGED, not replaced: `forwarded_at` / `forwarded_message_id` are the
        // only record of when this row went out and under which id.
        //
        // Then the user's Stop marker is DROPPED: the row is finished, so
        // nothing about it is waiting on the user any more. Leaving
        // `stop_paused` behind is what let `releaseInboxHold` put a prompt a
        // turn had already answered back on the queue.
        result: sql`(COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) || '{"status": "delivered"}'::jsonb) - 'stop_paused' - 'held'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          // Only a row this module owns. A `queued` row has not been forwarded
          // and a row already `delivered` is finished, so both are no-ops —
          // which is what makes the call idempotent under two witnesses.
          eq(sessionLifecycleCommands.status, 'succeeded'),
          sql`${sessionLifecycleCommands.result}->>'status' = 'forwarded'`,
          // The SAME id predicate every other reader matches on
          // (`wire-id-match.ts`), so none of them can disagree about which row
          // a wire id names. It was NOT the same until 2026-08-20: this one
          // read the payload only, so a row whose `result.forwarded_message_id`
          // differed from both payload ids was never closed here and read
          // `delivering` for ever.
          wireMessageIdMatches(wireMessageId),
        ),
      )
      .returning({ commandId: sessionLifecycleCommands.commandId });
    return rows.length;
  },
  async markConsumedOnDelivery(sessionId, wireMessageId) {
    const rows = await db
      .update(sessionLifecycleCommands)
      .set({
        // The PAYLOAD, because `markCommandForwarded` replaces `result`
        // wholesale — the same asymmetry `stopPausedOnDelivery` is written for.
        payload: sql`${sessionLifecycleCommands.payload} || '{"consumedOnDelivery": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          // ONLY a claimed row. A `queued` row has not been POSTed, so no
          // acceptance can name its id; a `succeeded` one is `confirm`'s.
          eq(sessionLifecycleCommands.status, 'running'),
          // Same shared predicate as every other reader. Its
          // `result.forwarded_message_id` branch cannot widen THIS query: a
          // row only reaches `running` from `queued` (`store.ts:683`,
          // `inbox-rows.ts:489`), and both requeue paths replace `result`
          // wholesale (`redelivery.ts`'s `requeue`,
          // `forwarded-strand-reconcile.ts`'s `requeueStranded`), so a
          // `running` row never carries a stale `forwarded_message_id`.
          wireMessageIdMatches(wireMessageId),
        ),
      )
      .returning({ commandId: sessionLifecycleCommands.commandId });
    return rows.length;
  },
  async listForwarded(olderThan, limit) {
    const rows = await db
      .select({
        commandId: sessionLifecycleCommands.commandId,
        sessionId: sessionLifecycleCommands.sessionId,
        wireMessageId: sql<string | null>`${sessionLifecycleCommands.payload}->>'wireMessageId'`,
        redeliveredMessageId: sql<
          string | null
        >`${sessionLifecycleCommands.payload}->>'redeliveredMessageId'`,
        updatedAt: sessionLifecycleCommands.updatedAt,
      })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          eq(sessionLifecycleCommands.status, 'succeeded'),
          sql`${sessionLifecycleCommands.result}->>'status' = 'forwarded'`,
          // A STOP-PAUSED row is parked by the user, not stranded by a missing
          // witness. Force-closing it would make the prompt they stopped
          // disappear from their queue instead of waiting there for them to
          // send it again.
          sql`COALESCE(${sessionLifecycleCommands.result}->>'stop_paused', '') <> 'true'`,
          lte(sessionLifecycleCommands.updatedAt, olderThan),
        ),
      )
      .orderBy(asc(sessionLifecycleCommands.updatedAt))
      .limit(limit);
    return rows
      .filter((row): row is typeof row & { sessionId: string } => !!row.sessionId)
      .map((row) => ({
        commandId: row.commandId,
        sessionId: row.sessionId,
        wireMessageId: row.wireMessageId,
        redeliveredMessageId: row.redeliveredMessageId,
        updatedAt: row.updatedAt,
      }));
  },
  async readLedgerTurn(sessionId, messageIds) {
    const [turn] = await db
      .select({ state: sessionTurns.state, endReason: sessionTurns.endReason })
      .from(sessionTurns)
      .where(
        and(eq(sessionTurns.sessionId, sessionId), inArray(sessionTurns.messageId, messageIds)),
      )
      // Newest first: a redelivered prompt has one ledger row per attempt, and
      // the LAST one is the attempt this row is waiting on.
      .orderBy(sql`${sessionTurns.startedAt} DESC`)
      .limit(1);
    return turn ? { state: turn.state, endReason: turn.endReason } : null;
  },
  logForceClosed(message, context) {
    logger.error(message, context);
  },
};

/**
 * A turn provably consumed this wire id — the row is finished.
 *
 * TWO SHAPES OF ROW, because the two witnesses fire at different points of the
 * row's own lifecycle:
 *
 *  - `completeSandboxTurn` runs long after the drain let go, so the row is
 *    `succeeded` + `forwarded` and can simply be CLOSED.
 *  - `acceptSandboxTurn` runs INSIDE the POST — `forwardToSandbox` awaits it
 *    before it returns, and `markCommandForwarded` runs only after
 *    `continueSession` returns — so the row is still `running` and still owned
 *    by the drain. Closing it there would be overwritten a moment later. The
 *    fact is left in the PAYLOAD instead, and `markCommandForwarded` lands it.
 *
 * Without the second shape the acceptance witness matched nothing on the one
 * path every composer prompt takes, and every prompt read `delivering` until
 * its whole turn ended.
 *
 * Idempotent, best-effort, and it NEVER throws: it is bookkeeping written on
 * the back of an authority write, and a failed confirmation must not fail the
 * turn.
 */
export async function confirmInboxPromptConsumed(
  sessionId: string,
  wireMessageId: string | null,
  deps: ConsumptionDeps = liveDeps,
): Promise<'confirmed' | 'pending_delivery' | 'no_prompt'> {
  // No wire id = nothing for the ledger to key on. Every automation producer
  // (triggers, Slack, approval-resume) is in this case by construction, and
  // their rows were never marked forwarded either.
  if (!wireMessageId) return 'no_prompt';
  try {
    if ((await deps.confirm(sessionId, wireMessageId)) > 0) return 'confirmed';
    return (await deps.markConsumedOnDelivery(sessionId, wireMessageId)) > 0
      ? 'pending_delivery'
      : 'no_prompt';
  } catch (error) {
    console.warn(
      '[session-lifecycle] inbox consumption confirm failed:',
      error instanceof Error ? error.message : error,
    );
    return 'no_prompt';
  }
}

/**
 * The bound: close forwarded rows whose witness never arrived.
 *
 * ONLY EVER CLOSES ROWS. Redelivery stays the reaper's job, because only the
 * reaper holds the daemon's proof that a turn never ran.
 */
export async function reconcileForwardedPrompts(
  now = new Date(),
  deps: ConsumptionDeps = liveDeps,
): Promise<{ scanned: number; confirmed: number; forceClosed: number }> {
  const rows = await deps.listForwarded(
    new Date(now.getTime() - INBOX_FORWARD_CONFIRM_GRACE_MS),
    FORWARDED_SCAN_BATCH,
  );
  const out = { scanned: rows.length, confirmed: 0, forceClosed: 0 };

  for (const row of rows) {
    const ids = [row.wireMessageId, row.redeliveredMessageId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    // `markCommandForwarded` is only ever called WITH a wire id, so this cannot
    // happen — and if it somehow does, there is nothing to confirm against and
    // nothing this sweep could close. Skipping beats looping on it for ever.
    if (ids.length === 0) continue;
    const turn = await deps.readLedgerTurn(row.sessionId, ids);
    const expired = now.getTime() - row.updatedAt.getTime() >= INBOX_FORWARD_CONFIRM_MAX_MS;

    // A turn that is RUNNING, or that ran to an ending, consumed the prompt.
    // `active` counts: the ledger only opens an active row once OpenCode has
    // accepted the delivery, which is the moment the message became the
    // transcript's rather than the inbox's.
    const ran =
      turn?.state === 'active' ||
      (turn?.state === 'ended' &&
        !!turn.endReason &&
        !PROMPT_NEVER_RAN_END_REASONS.has(turn.endReason as never));
    if (ran) {
      if (await deps.confirm(row.sessionId, ids[0])) out.confirmed += 1;
      continue;
    }

    // A ledger row still `delivering` is OpenCode HOLDING this message behind
    // the turn in front of it — the flagship mid-turn case, and the p99 turn
    // (~78 min, `sandbox-deadline-policy.ts`) is eight times this ceiling.
    // Force-closing there deletes a pending message from the user's queue while
    // OpenCode is still going to run it, and raises an error-level log on a
    // completely healthy flow.
    //
    // The wait is bounded by the LEDGER, not by this sweep: when the box parks,
    // dies or answers, the reaper and `settleOrphanedSandboxTurns` end the
    // record — and an ended record reaches one of the two branches around this
    // one on the next pass.
    if (turn?.state === 'delivering') continue;

    if (!expired) continue;

    // Past the ceiling, and still no proof. Two shapes reach here and both are
    // force-closed rather than left to hang:
    //  - NO LEDGER ROW: the ledger write is best-effort, so its absence is not
    //    evidence of anything;
    //  - a NEVER-RAN ending nobody came back for. `requeueAbandonedPrompt`
    //    owns those rows and flips them to `queued` — which takes them out of
    //    this scan — but it only fires when the daemon proves the prompt was
    //    ORPHANED. A turn closed `unknown` because a newer prompt took the
    //    root (the measured mid-turn case: the daemon's message-scoped probe
    //    reads "a newer user message owns the root" as terminal) is never
    //    redelivered, so waiting for that redelivery would wait for ever.
    if (await deps.confirm(row.sessionId, ids[0])) {
      out.forceClosed += 1;
      deps.logForceClosed(
        '[session-lifecycle] forwarded prompt closed with no proof it was consumed',
        {
          command_id: row.commandId,
          session_id: row.sessionId,
          wire_message_id: row.wireMessageId,
          redelivered_message_id: row.redeliveredMessageId,
          ledger_state: turn?.state ?? null,
          ledger_end_reason: turn?.endReason ?? null,
          age_ms: now.getTime() - row.updatedAt.getTime(),
        },
      );
    }
  }
  return out;
}
