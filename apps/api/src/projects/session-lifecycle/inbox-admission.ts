import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { RUNTIME_STABLE_MESSAGE_ID_CAPABILITY, type RuntimeCapability } from '@kortix/api-contract/runtime-relay';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { sandboxOpencodeEndpoint } from '../opencode-mapping';
import { RUNNING_SANDBOX_STATUSES, storedSandboxTurns, type StoredSandboxTurn } from '../session-turn-ledger';
import { inboxFollowsRow, inboxPrecedesRow } from './inbox-order';
import { reconcileInboxTurn } from './inbox-turn-recovery';
import { runtimeCapabilities } from './runtime-fetch';
import type { InboxAdmissionReason, SessionLifecycleCommandRow } from './store';
import { recordSteerFallback } from './command-transitions';
import { notHeldSql } from './delivery-state';
import { wireMessageIdMatches } from './wire-id-match';

/**
 * The inbox's admission gate.
 *
 * ONE DELIVERY MODE: STEER (2026-11-04). A prompt sent while a turn runs goes
 * to that turn (`POST .../steer`), and the runtime reads it at the turn's next
 * step, after the running tool call returns. A prompt sent while no turn runs
 * starts the next turn. No client, placement or `delivery` value changes this:
 * `queue` and `interrupt` from an older client are read as steer.
 *
 * What was removed, and why it is not coming back without the product owner:
 * - "Queue List" held a prompt until the whole turn ended. A long autonomous
 *   turn then never received what the user typed (prod, 2026-11-04: "go on"
 *   waited out a 30-step turn). The same hold was reverted on 2026-08-21
 *   (learnings: "a comment saying this was tried and reverted ...").
 * - The prompter rule (`not_prompter`) turned a steer from anyone but the
 *   turn's prompter into a queue row. It also caught the agent's own subagent
 *   results, which then waited behind the turn that was waiting for them.
 * - "Quick Queue" ended the turn after its running tool. Steer reaches the
 *   same step boundary without ending the turn.
 *
 * Rows still go out one at a time, in send order (`inbox-order.ts`), and a row
 * waits while an older one is in flight. A steer the runtime refuses because
 * its turn just ended (`turn_ended`) waits for that one turn's end and then
 * starts the next turn. A runtime without `session.steer` (`unsupported`)
 * gets the prompt as the next turn.
 *
 * ONE EXCEPTION (KRTX-683): prompts released from a Stop hold. The release
 * stamps them with one `releasedBatchId`, and they share ONE answer. They are
 * still admitted one at a time, in order, as separate user messages, but every
 * row with a later row of its batch pending (`hasLaterReleasedSibling`) goes
 * out `noReply` and the batch's last row starts the one turn that answers
 * them all.
 *
 * WAITING IS NOT POLLING. The instant a turn ends, `promoteNextInboxRow` makes
 * the session's next row due and drains it (`routes/turn-stream.ts`). The
 * backoff below only covers the gap a lost kick would leave, so it stays cheap
 * and capped.
 *
 * A refusal is NOT a failure: see `requeueForAdmission`, which gives the claim's
 * attempt increment back so waiting cannot burn the 5-attempt dead-letter budget.
 */
export const INBOX_ORDER_BACKOFF_MS = 300;
/**
 * The ceiling is LOW on purpose. A refused row is not polling for a whole cold
 * boot any more: a reply delivery opens a turn, and that turn's end calls
 * `promoteNextInboxRow`, which makes the session's next queued row due NOW and
 * drains it. A `noReply` delivery opens no turn, so it makes that call itself
 * (`queued-continue.ts`). The reaper repeats the wake for recovery. This backoff only covers the
 * gap a lost kick would leave. 30s here was the entire "queue does not send
 * between turns" experience: three quick messages compounded to 27s / 45s /
 * 75s of dead air behind ~1s deliveries.
 */
export const INBOX_ORDER_MAX_BACKOFF_MS = 2_000;
/**
 * A row refused this many times (~2 min at the 2s cap) behind an older prompt
 * on a box that is NOT running waits on a parked head: a failed or stopped
 * session whose head sits out the runtime-unreachable ladder. It re-polls once
 * a minute instead. Prod 2026-10-20: ~200 such rows, every one on a stopped
 * box, were refused 28 times a second.
 *
 * The box gate is what makes this safe. `admission_refusals` counts every
 * reason, `turn_active` included, so a row that waited out a long live turn
 * crosses 64 while its head still moves; on a running box it keeps the 2s cap.
 * The minute is a fallback, not the wake. These exits make the next row due at
 * once (`promoteNextInboxRow`): turn end, the reaper, forwarded-strand
 * reconcile, a `noReply` delivery, a dead-lettered head (`markCommandFailed`),
 * a removed head (`deleteInboxPrompt`), and a head closed without a post
 * (`executeQueuedContinue`: consumed in band, skipped).
 */
/*
 * The same minute applies to a row that waits behind a live turn but is not the
 * session's head. Prod 2026-11-03: 93 cron prompts queued behind turns in 4
 * sessions were each re-polled every 2 s, 29 claims a second, each reading the
 * sandbox row twice. Only the head can be admitted next, and the turn's end
 * wakes the head, never a row behind it.
 */
export const INBOX_STALE_ORDER_REFUSALS = 64;
export const INBOX_STALE_ORDER_BACKOFF_MS = 60_000;
const INBOX_BACKOFF_FREE_REFUSALS = 4;

/** `base * 2^(refusals - free)`, capped. Pure, so the curve is testable. */
export function admissionBackoffMs(baseMs: number, capMs: number, refusals: number): number {
  // Clamped before the shift: `2 ** 1e9` is Infinity, and `Math.min` would
  // hand that straight to a Date constructor.
  const exponent = Math.min(Math.max(Math.trunc(refusals) - INBOX_BACKOFF_FREE_REFUSALS, 0), 16);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** How many times this row has already been put back by the admission gate. */
function admissionRefusals(result: unknown): number {
  const value = (result as { admission_refusals?: unknown } | null)?.admission_refusals;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The one thing that still holds a prompt back. Kept as a union because it is
 *  written into `result.admission_reason` and served as `GET .../prompts`'
 *  `reason`, where a second value may well appear again. */
export type InboxAdmission =
  /** `steerInto`: post to `/steer`; the running turn of that message reads it. */
  | { admit: true; steerInto?: string }
  | {
      admit: false;
      reason: InboxAdmissionReason;
      retryAfterMs: number;
    };

/**
 * Does this session hold live turn authority right now?
 *
 * Exactly the predicate `GET /sessions/{id}/turn` serves from: the lifecycle
 * authority is `session_sandboxes.metadata.activeTurns` READ AGAINST A RUNNING
 * BOX. Metadata outlives the runtime, so a stopped box holds nothing whatever
 * its metadata still says. Pure over the two fields, so the truth table is
 * testable without a database.
 *
 * Admission, `GET .../turn`, and `settleOrphanedSandboxTurns` share this exact
 * predicate. A stopped box never holds authority even when stale metadata still
 * contains an active turn.
 */
export function sessionHoldsTurnAuthority(
  box: { status: string; metadata: Record<string, unknown> | null } | null,
): boolean {
  return (
    !!box && RUNNING_SANDBOX_STATUSES.has(box.status) && storedSandboxTurns(box.metadata).length > 0
  );
}

/**
 * The same question, against the database, for one session.
 *
 * The drain also uses this read when it must decide whether a client-minted id
 * is still correctly placed.
 */
export async function sessionHoldsLiveTurn(sessionId: string): Promise<boolean> {
  // `session_sandboxes.session_id` is UNIQUE, so this is the session's one box.
  // Served by idx_session_sandboxes_session.
  const [box] = await db
    .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  return sessionHoldsTurnAuthority(box ?? null);
}

export interface InboxAdmissionDeps {
  /** Recover a missed terminal relay from exact runtime evidence. */
  reconcileTurn?: (sessionId: string) => Promise<void>;
  /** The session's one sandbox row — its `metadata.activeTurns` is the turn
   *  authority `sessionHoldsTurnAuthority` reads. */
  readSandbox: (
    sessionId: string,
  ) => Promise<{ status: string; metadata: Record<string, unknown> | null; externalId?: string | null } | null>;
  hasOlderPendingPrompt: (sessionId: string, row: SessionLifecycleCommandRow) => Promise<boolean>;
  /** Is another prompt of this session ALREADY CLAIMED and mid-delivery?
   *  Separate from the ordering read because it binds even a promoted row. */
  hasInFlightPrompt: (sessionId: string, exceptCommandId: string) => Promise<boolean>;
  /** The reads a steer needs. Absent (tests only): no row steers. */
  steer?: SteerAdmissionDeps;
}

/**
 * The live turn a steer goes to: the NEWEST stored turn.
 *
 * Not `turns.length === 1 ? turns[0] : null`: one entry that outlived its end
 * relay would then park every prompt behind the whole run. The newest entry is
 * the turn that is running; an older entry is a ledger leftover the reaper owns.
 */
export function newestStoredTurn(turns: StoredSandboxTurn[]): StoredSandboxTurn | null {
  let newest: StoredSandboxTurn | null = null;
  for (const turn of turns) {
    if (!newest || (turn.startedAtMs ?? -1) > (newest.startedAtMs ?? -1)) newest = turn;
  }
  return newest;
}

export interface SteerAdmissionDeps {
  /** `/kortix/health` `capabilities` of the box; null when the read failed. */
  capabilities: (externalId: string | null | undefined, actorUserId: string | null) => Promise<string[] | null>;
  recordFallback: (row: SessionLifecycleCommandRow, reason: 'unsupported') => Promise<void>;
}

const STEER_CAPABILITY: RuntimeCapability = 'session.steer';

/** `/kortix/health` `capabilities` of a sandbox's runtime (memoized 5 min); null when the read failed. */
function readRuntimeCapabilities(externalId: string | null | undefined, actorUserId: string | null): Promise<string[] | null> {
  return runtimeCapabilities(externalId ?? undefined, () =>
    sandboxOpencodeEndpoint(externalId!, actorUserId ?? undefined));
}

/**
 * Does this sandbox's runtime keep a delivered prompt's message id
 * (`RUNTIME_STABLE_MESSAGE_ID_CAPABILITY`)? Then a prompt goes out under the id
 * it already has. False when the read fails or the box does not list it: the
 * caller re-mints, as for OpenCode, which orders by id.
 */
export async function sandboxKeepsMessageIds(externalId: string | null | undefined, actorUserId: string | null): Promise<boolean> {
  return (await readRuntimeCapabilities(externalId, actorUserId))?.includes(RUNTIME_STABLE_MESSAGE_ID_CAPABILITY) ?? false;
}

/** `sandboxKeepsMessageIds` for the session's box. False when the box cannot be read. */
export async function sessionKeepsMessageIds(sessionId: string | null | undefined, actorUserId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const box = await liveInboxAdmissionDeps.readSandbox(sessionId);
    return await sandboxKeepsMessageIds(box?.externalId, actorUserId);
  } catch {
    return false;
  }
}

export const liveInboxAdmissionDeps: InboxAdmissionDeps = {
  reconcileTurn: reconcileInboxTurn,
  async readSandbox(sessionId) {
    const [box] = await db
      .select({
        status: sessionSandboxes.status,
        metadata: sessionSandboxes.metadata,
        externalId: sessionSandboxes.externalId,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);
    return box ?? null;
  },
  async hasOlderPendingPrompt(sessionId, row) {
    const [older] = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          inArray(sessionLifecycleCommands.status, ['queued', 'running']),
          // A HELD row is deliberately out of the line — the user stopped it.
          // Counting it would wedge every prompt they send afterwards behind a
          // row that is, by construction, never due.
          notHeldSql,
          inboxPrecedesRow(row),
          // Explicitly not itself. The tuple predicate already excludes this
          // row, but a row that blocks on itself waits for ever if a concurrent
          // writer changes one of its ordering fields.
          ne(sessionLifecycleCommands.commandId, row.commandId),
        ),
      )
      .limit(1);
    return !!older;
  },
  async hasInFlightPrompt(sessionId, exceptCommandId) {
    const [running] = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          eq(sessionLifecycleCommands.status, 'running'),
          ne(sessionLifecycleCommands.commandId, exceptCommandId),
        ),
      )
      .limit(1);
    return !!running;
  },
  steer: {
    capabilities: readRuntimeCapabilities,
    recordFallback: (row, reason) => recordSteerFallback(row, reason),
  },
};

/**
 * Any row and a running turn. Admitted as a steer into the newest active turn
 * when the runtime lists `session.steer`.
 *
 * - A runtime without `session.steer` records `unsupported` once and returns
 *   `fallback`: the caller holds the row for the turn's end.
 * - A steer the runtime refused into THIS turn (`steerRefusedTurn`, written by
 *   `deliverSteer` on 409 `no_active_turn`) returns `fallback` too, so the row
 *   is not re-posted into a turn that is ending. A newer turn steers again.
 * - A turn still being delivered (no message id yet) or an unreadable
 *   capability list: the row waits on the short clock and steers next time.
 */
async function admitSteer(
  row: SessionLifecycleCommandRow,
  sandbox: { metadata: Record<string, unknown> | null; externalId?: string | null } | null,
  steer: SteerAdmissionDeps,
  retryAfterMs: number,
): Promise<InboxAdmission | 'fallback'> {
  const active = newestStoredTurn(storedSandboxTurns(sandbox?.metadata));
  if (active?.state !== 'active' || !active.messageId) {
    return { admit: false, reason: 'turn_active', retryAfterMs };
  }
  const refusedTurn = (row.payload as { steerRefusedTurn?: unknown } | null)?.steerRefusedTurn;
  if (refusedTurn === active.messageId) return 'fallback';
  const capabilities = await steer.capabilities(sandbox?.externalId, row.actorUserId);
  if (capabilities === null) return { admit: false, reason: 'turn_active', retryAfterMs };
  if (!capabilities.includes(STEER_CAPABILITY)) {
    await steer.recordFallback(row, 'unsupported');
    return 'fallback';
  }
  return { admit: true, steerInto: active.messageId };
}

export async function admitInboxPrompt(
  row: SessionLifecycleCommandRow,
  deps: InboxAdmissionDeps = liveInboxAdmissionDeps,
): Promise<InboxAdmission> {
  // A row with no session cannot be ordered or gated. Admit it so the drain
  // reaches its own honest failure instead of requeueing it for ever.
  if (!row.sessionId) return { admit: true };

  const refusals = admissionRefusals(row.result);
  const orderBackoffMs = admissionBackoffMs(
    INBOX_ORDER_BACKOFF_MS,
    INBOX_ORDER_MAX_BACKOFF_MS,
    refusals,
  );
  // THE THREE READS THIS GATE ASKS FOR ARE INDEPENDENT, so they go out
  // together. Awaiting them one at a time cost three sequential round trips on
  // every delivery, and the API does not share a region with its database
  // everywhere it runs (dev: API us-west-2, database us-east-2, ~100 ms per
  // query). The gate below still CONSUMES them in its original order, and each
  // one is awaited exactly where its answer is first needed, so the verdict for
  // any given state is unchanged. Each read also now happens once instead of
  // twice on the path where a live turn clears.
  const started = <T>(promise: Promise<T>): Promise<T> => {
    // An early return may leave one of these unawaited; a rejection must not
    // surface as an unhandled rejection. The awaiting site still sees it.
    promise.catch(() => undefined);
    return promise;
  };
  const sandboxRead = started(deps.readSandbox(row.sessionId));
  const inFlightRead = started(deps.hasInFlightPrompt(row.sessionId, row.commandId));
  const olderRead = started(deps.hasOlderPendingPrompt(row.sessionId, row));

  // A live turn: the session's head row steers it. Rows still go out one at a
  // time and in send order, so a row behind an older one (queued, or claimed
  // and mid-delivery) waits for it; a steer the runtime holds is `forwarded`,
  // not pending, so the next row follows it within one drain.
  let sandbox = await sandboxRead;
  if (sessionHoldsTurnAuthority(sandbox)) {
    const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
    const isHead = !(await inFlightRead) && (promoted || !(await olderRead));
    if (!isHead) {
      // Woken by the head's own progress (`promoteNextInboxRow` makes the next
      // row due the moment the head goes out); this clock is the fallback.
      return {
        admit: false,
        reason: 'older_prompt_pending',
        retryAfterMs: Math.max(orderBackoffMs, INBOX_STALE_ORDER_BACKOFF_MS),
      };
    }
    // `postPrompt` speaks for a user; a row with no actor starts the next turn.
    if (deps.steer && row.actorUserId) {
      const steered = await admitSteer(row, sandbox, deps.steer, orderBackoffMs);
      if (steered !== 'fallback') return steered;
    }
    // This row cannot steer this turn: it starts the next one. Recover a
    // missed terminal relay first, so a turn that already ended does not hold it.
    if (deps.reconcileTurn) {
      await deps.reconcileTurn(row.sessionId);
      sandbox = await deps.readSandbox(row.sessionId);
    }
    if (sessionHoldsTurnAuthority(sandbox)) {
      return { admit: false, reason: 'turn_active', retryAfterMs: orderBackoffMs };
    }
  }

  const parked = !(sandbox && RUNNING_SANDBOX_STATUSES.has(sandbox.status));
  const waitBackoffMs =
    parked && refusals >= INBOX_STALE_ORDER_REFUSALS ? INBOX_STALE_ORDER_BACKOFF_MS : orderBackoffMs;

  // ONE PROMPT OF A SESSION ON THE WIRE AT A TIME, and this check binds even a
  // promoted row. A claimed row spends up to READY_DEADLINE_MS (5 min) inside
  // `continueSession` waiting for a cold box, with no message written for any
  // of it. Admitting a second prompt into that window races two deliveries of
  // one session, and OpenCode orders what it receives by ARRIVAL — so the loser
  // of that race is the message the user typed FIRST.
  if (await inFlightRead) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: waitBackoffMs };
  }

  // "Send now"/retry stamps `promoted`: the user pointed at ONE row and asked
  // for THAT message. QUEUE ORDER yields to that; the in-flight check above
  // does not, because it is about a delivery already happening rather than
  // about which message goes first.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  if (!promoted && (await olderRead)) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: waitBackoffMs };
  }

  return { admit: true };
}

/**
 * Is a LATER prompt of this row's released Stop batch still waiting to go out?
 * Then this row goes out `noReply` (KRTX-683): OpenCode persists it as its own
 * user message and starts no turn, and the batch's last prompt starts the one
 * turn that answers them all.
 *
 * Read from the database at delivery time, never from what one drain happened
 * to claim. Concurrent drains (the targeted wake, the 1 s tick, another API
 * instance) can split one batch across lanes, and a lane that saw no later row
 * sent its head as a turn of its own — a second answer for one release. A later
 * row counts while `queued` or `running` (claimed by another drain, not yet
 * sent); a HELD row does not, since a new Stop took it out of the line.
 *
 * The decision and the POST are not atomic: a row deleted, or held by a new
 * Stop, during a cold-box wait leaves the earlier noReply rows unanswered until
 * the next send.
 */
export async function hasLaterReleasedSibling(row: SessionLifecycleCommandRow): Promise<boolean> {
  const batchId = (row.payload as { releasedBatchId?: unknown } | null)?.releasedBatchId;
  if (!row.sessionId || typeof batchId !== 'string' || batchId.length === 0) return false;
  const [later] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, row.sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        inArray(sessionLifecycleCommands.status, ['queued', 'running']),
        notHeldSql,
        sql`${sessionLifecycleCommands.payload}->>'releasedBatchId' = ${batchId}`,
        inboxFollowsRow(row),
        ne(sessionLifecycleCommands.commandId, row.commandId),
      ),
    )
    .limit(1);
  return !!later;
}
