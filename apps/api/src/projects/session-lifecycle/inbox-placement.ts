/**
 * Where an inbox prompt's wire id lands in the OpenCode transcript: the
 * re-mint above everything on record, the proof read after a live-turn
 * delivery, and the repair of a prompt that landed below a newer answer.
 * The pure placement rules live in `forwarded-placement.ts`.
 */

import { sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type SessionLifecycleCommandRow,
  withNextDeliveryAttempt,
  withRemintedWireId,
  type QueuedContinueSessionPayload,
} from './store';
import { inboxFollowsRow } from './inbox-order';
import {
  boxClockSkewMs,
  mintLivePlacement,
  noteBoxClockSample,
  remintFloorTime,
  strandedPlacement,
} from './forwarded-placement';
import {
  MAX_WIRE_ID_CLOCK_CORRECTION,
  WIRE_ID_TIME_SCALE,
  newestWireIdTime,
  wireIdClockDelta,
} from '../wire-message-id';
import { type InboxTranscriptState, readInboxTranscriptState } from './runtime-client';

/**
 * How far back the inbox's own delivered ids are worth reading.
 *
 * DERIVED, not chosen: `MAX_WIRE_ID_CLOCK_CORRECTION` is the widest lift
 * `mintWireMessageId` will accept, so an id older than that cannot move a mint
 * at all. Bounding the scan to it keeps a long-lived session's row history out
 * of every re-mint, and the two cannot drift apart.
 */
const DELIVERED_WIRE_ID_FLOOR_WINDOW_MS = Number(
  MAX_WIRE_ID_CLOCK_CORRECTION / WIRE_ID_TIME_SCALE,
);

/**
 * Rows read for the delivered floor. A session sends far fewer prompts than
 * this inside one `DELIVERED_WIRE_ID_FLOOR_WINDOW_MS`; the newest rows are
 * read first, so a cap that is ever hit drops only the oldest ids.
 */
const DELIVERED_WIRE_ID_FLOOR_ROW_LIMIT = 500;

/**
 * The newest wire id THIS SESSION has already put on the wire, read from our
 * own rows rather than from OpenCode's transcript.
 *
 * SQL returns the ids; the SDK orders them (`newestWireIdTime`, on the 48-bit
 * ring). A SQL `max()` over the decoded clock would rank every pre-wrap id
 * above every post-wrap one, and would duplicate the clock arithmetic. An id
 * more than MAX_WIRE_ID_CLOCK_CORRECTION ahead of the clock (the pre-fix CLI
 * minted the HIGH bits, ~40 days out) is skipped by the same call: it would
 * otherwise BE the newest and hide every real floor under it.
 *
 * Fails OPEN (`null`), like every other read on this path: a floor that cannot
 * be read must not block a prompt, and the transcript floor still applies.
 */
async function readDeliveredWireIdFloor(
  row: SessionLifecycleCommandRow,
): Promise<bigint | null> {
  if (!row.sessionId) return null;
  try {
    const rows = await db
      .select({
        submitted: sql<string | null>`${sessionLifecycleCommands.payload}->>'wireMessageId'`,
        redelivered: sql<string | null>`${sessionLifecycleCommands.payload}->>'redeliveredMessageId'`,
        forwarded: sql<string | null>`${sessionLifecycleCommands.result}->>'forwarded_message_id'`,
      })
      .from(sessionLifecycleCommands)
      // Served by idx_session_lifecycle_commands_session.
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, row.sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          gte(
            sessionLifecycleCommands.updatedAt,
            new Date(Date.now() - DELIVERED_WIRE_ID_FLOOR_WINDOW_MS),
          ),
        ),
      )
      .orderBy(desc(sessionLifecycleCommands.updatedAt))
      .limit(DELIVERED_WIRE_ID_FLOOR_ROW_LIMIT);
    return newestWireIdTime(
      rows.flatMap((found) => [found.submitted, found.redelivered, found.forwarded]),
      Date.now(),
    );
  } catch (err) {
    console.warn('[session-lifecycle] delivered wire-id floor read failed — using the transcript', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Mint the wire id this attempt delivers with, placed above the root's newest
 * message, and persist it before the POST.
 *
 * TWO callers need this, for one reason. On a box running opencode <= 1.18.14
 * (the baked 1.17.11 on every image built before 2026-08-20) the loop resolves
 * "has this prompt already been answered?" by ID ORDER, so an id that sorts
 * below what is on record is accepted and then silently never runs. From
 * 1.18.15 the exit test is `lastAssistant.parentID === lastUser.id` and a low
 * id no longer drops the prompt — but it still places the message BELOW the
 * answer on screen, because `MessageV2.page()` orders by `time_created` then
 * `id` in both versions. Re-minting is required on the old boxes and is
 * cosmetic-but-still-wanted on the new ones:
 *
 *  - a REDELIVERY: the abandoned attempt may already have persisted its user
 *    message, and repeating that id reads as already answered;
 *  - a prompt that WAITED: the client minted its id when the user pressed
 *    Enter, and the turn it queued behind has been writing higher ids ever
 *    since. This is the ordinary case, not the exotic one — it is what "queue
 *    while busy" does on every single send.
 *
 * Persisted into `payload.redeliveredMessageId` BEFORE delivery, so a crash
 * between mint and POST reuses one id rather than minting a second.
 *
 * A FAILED transcript read still mints rather than blocking the prompt — but it
 * must not mint blind. `mintWireMessageId` backdates by `WIRE_ID_BACKDATE_MS`
 * (2 min) on purpose: too early is self-correcting when there IS a transcript
 * to lift against. With no transcript there is nothing to lift against, and
 * OpenCode mints its own ids from a raw `Date.now()` with no backdate — so the
 * fallback would land two minutes BELOW every message the box wrote in the last
 * two minutes, which is the exact silent drop this function exists to prevent.
 * The un-backdated clock is the floor instead. An unreadable box is also the
 * commonest trigger for a redelivery, so this path is not the exotic one.
 */
export async function remintWireMessageId(
  row: SessionLifecycleCommandRow,
  payload: QueuedContinueSessionPayload,
  transcript: InboxTranscriptState,
): Promise<string> {
  // THE TRANSCRIPT IS NOT THE ONLY FLOOR — it lags. OpenCode persists a
  // mid-turn user message ~4s after the POST (measured against a real sandbox
  // in `inbox-midturn-forward.live.test.ts`), and two prompts sent
  // inside that window read the SAME `newest` and mint the SAME clock. The
  // user's own two messages then sort by 14 random base62 characters: either
  // they run in the wrong order, or the loser sorts under an assistant reply
  // and OpenCode reads it as already answered and never runs it. The inbox
  // already knows every id it put on the wire; that is the missing floor.
  // `remintFloorTime` merges the three floors on the 48-bit ring.
  const newest = remintFloorTime({
    transcript,
    deliveredNewest: await readDeliveredWireIdFloor(row),
    submittedMessageId: payload.wireMessageId,
    nowMs: Date.now(),
  });

  // Placed at the BOX's clock "now" when it is known (see forwarded-placement
  // .ts): newest+1 is only safe while nothing else is minting, and a live turn
  // mints an assistant id at every step boundary.
  const minted = mintLivePlacement({
    nowMs: Date.now(),
    newestKnownTime: newest,
    boxSkewMs: row.sessionId ? boxClockSkewMs(row.sessionId) : null,
  });
  if (newest !== null && wireIdClockDelta(minted.time, newest) <= BigInt(0)) {
    // The lift refused: `MAX_WIRE_ID_CLOCK_CORRECTION` (1h) caps how far a
    // transcript may drag an id, and past that cap the id we are about to send
    // sorts BELOW what is on record.
    //
    // WHAT THAT COSTS DEPENDS ON THE BOX'S OPENCODE VERSION, so this is a WARN
    // and not an ERROR, and it no longer claims the turn is lost:
    //  - opencode <= 1.18.14 (baked 1.17.11): the loop's exit check is an id
    //    compare, so the prompt is read as already answered and the turn does
    //    not run. Nothing here can repair that; `forwarded-strand-reconcile`
    //    picks it up at turn end.
    //  - opencode >= 1.18.15: the exit check is
    //    `lastAssistant.parentID === lastUser.id`. The turn RUNS. The only
    //    damage is transcript position — the message renders below the answer
    //    that precedes it, because `MessageV2.page()` orders by `time_created`.
    // Reported either way, because a refused lift always means the clock
    // estimate is wrong by more than an hour.
    logger.warn('[session-lifecycle] re-minted wire id could not clear the transcript', {
      session_id: row.sessionId,
      command_id: row.commandId,
      minted_time: minted.time.toString(),
      newest_known_time: newest.toString(),
      transcript_read: transcript.read,
    });
  }
  try {
    await db
      .update(sessionLifecycleCommands)
      .set({
        payload: withRemintedWireId(minted.id),
        updatedAt: new Date(),
      })
      .where(eq(sessionLifecycleCommands.commandId, row.commandId));
  } catch (err) {
    // Losing the persist costs a re-mint on the next attempt, nothing more.
    // Throwing here would abandon a CLAIMED row in `running`, where nothing
    // reclaims it until its lock expires.
    console.warn('[session-lifecycle] could not persist the re-minted wire id', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return minted.id;
}

/** How many times one delivery re-places itself before leaving the rest to
 *  turn-end reconciliation. Each round is one tip read + one DELETE + one POST
 *  — a second strand in a row means step boundaries are landing inside every
 *  window, and the turn-end net is the cheaper place to catch it. */
export const MAX_LIVE_PLACEMENT_REPAIRS = 2;

/**
 * Read the tip once after a live-turn delivery and say whether the prompt
 * landed where the loop will run it — see `strandedPlacement`. Also takes the
 * box-clock sample the next placement for this session mints from.
 *
 * Fails OPEN as "not stranded": an unreadable tip proves nothing, and the
 * turn-end reconciliation re-asks the question with the same predicate.
 */
export async function verifyLivePlacement(
  row: SessionLifecycleCommandRow,
  wireMessageId: string,
  postedAtMs: number,
): Promise<{ stranded: boolean; strandedBy: string | null; newest: bigint | null }> {
  const ackAtMs = Date.now();
  const transcript = await readInboxTranscriptState(row, [wireMessageId]);
  if (!transcript.read || !transcript.tip) return { stranded: false, strandedBy: null, newest: null };
  const verdict = strandedPlacement(transcript.tip, wireMessageId);
  if (row.sessionId && verdict.createdMs !== null && verdict.createdMs >= postedAtMs - 60_000) {
    // The box stamped `created` somewhere between our POST and its ack; the
    // ack is the conservative pairing (see `noteBoxClockSample`).
    noteBoxClockSample(row.sessionId, verdict.createdMs, ackAtMs);
  }
  return { stranded: verdict.stranded, strandedBy: verdict.strandedBy, newest: verdict.newest };
}

/** Is a forwarded/queued inbox row of this session NEWER than `row` already
 *  on the wire (or in line)? Then `row`'s send order is pinned by it. */
export async function hasLaterForwardedSibling(row: SessionLifecycleCommandRow): Promise<boolean> {
  if (!row.sessionId) return false;
  try {
    const [later] = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, row.sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          sql`${sessionLifecycleCommands.payload}->>'clientMessageId' IS NOT NULL`,
          inboxFollowsRow(row),
          or(
            inArray(sessionLifecycleCommands.status, ['queued', 'running']),
            sql`${sessionLifecycleCommands.result}->>'status' = 'forwarded'`,
          ),
        ),
      )
      .limit(1);
    return !!later;
  } catch {
    return false; // fail open: a solo repair is better than none
  }
}

/**
 * Mint the id a REPAIR goes out under — above the assistant that proved the
 * strand — and persist it with the next delivery attempt BEFORE the POST, for
 * the same crash-safety reason `remintWireMessageId` persists first.
 */
export async function remintForRepair(
  row: SessionLifecycleCommandRow,
  newestKnownTime: bigint | null,
): Promise<string> {
  const minted = mintLivePlacement({
    nowMs: Date.now(),
    newestKnownTime,
    boxSkewMs: row.sessionId ? boxClockSkewMs(row.sessionId) : null,
  });
  try {
    await db
      .update(sessionLifecycleCommands)
      .set({
        payload: withNextDeliveryAttempt(withRemintedWireId(minted.id)),
        updatedAt: new Date(),
      })
      .where(eq(sessionLifecycleCommands.commandId, row.commandId));
  } catch (err) {
    console.warn('[session-lifecycle] could not persist the re-placed wire id', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return minted.id;
}
