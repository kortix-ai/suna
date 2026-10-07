import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import type { RuntimeCapability } from '@kortix/api-contract/runtime-relay';
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
 * ONE QUEUED MESSAGE RUNS AT A TIME, IN ORDER, AND EACH GETS ITS OWN ANSWER.
 * A prompt sits in `session_lifecycle_commands` until the session's turn is
 * over AND every older prompt has left the delivery path. The first Quick
 * Queue prompt may end that turn after its current tool call finishes. Queue
 * List prompts wait for natural turn completion.
 *
 * ONE EXCEPTION (KRTX-683): prompts released from a Stop hold. The release
 * stamps them with one `releasedBatchId`, and they share ONE answer. They are
 * still admitted one at a time, in order, as separate user messages, but every
 * row with a later row of its batch pending (`hasLaterReleasedSibling`) goes
 * out `noReply` — OpenCode persists it and starts no loop, and the row closes
 * `delivered` with `no_reply: true` — and the batch's last row starts the one
 * turn that answers them all.
 *
 * The turn half is not belt-and-braces on the order half — it is the whole
 * feature. OpenCode picks up new user messages at STEP boundaries INSIDE a
 * running turn, and it "parents each step on the newest user message and
 * answers everything before it in that step" (`forwarded-placement.ts`). So
 * every prompt forwarded into a live turn is merged into whatever step reaches
 * it: two queued messages share one answer, and the earlier one is simply
 * never spoken. Measured 2026-09-04 — a 13-step research turn with "tell me
 * HI" and "tell me bye" queued behind it produced exactly one reply, "bye".
 *
 * Forwarding mid-turn was tried (`4ee30a9c3b`) to remove the gap between
 * queued messages. It bought that merge. The gap it was removing is gone by
 * other means: `promoteNextInboxRow` is AWAITED on the daemon's own
 * `session.idle` relay (`routes/turn-stream.ts`, "THE TURN ENDED — the session's next
 * queued prompt is admissible NOW"), and the backoff below is now a 2s-capped
 * fallback rather than the 30s ceiling that produced the measured dead air.
 * A queued message therefore goes out on the turn-end event, not on a clock.
 *
 * WAITING IS NOT POLLING. A refused row does not sit out a backoff clock: the
 * instant the turn ends, `promoteNextInboxRow` makes the session's next row due
 * and drains it. The reaper is a recovery wake. The backoff below only covers
 * the gap a lost kick would leave, so it stays cheap and capped — 30s here
 * compounded to 27s / 45s / 75s of dead air behind ~1s deliveries (dev,
 * 2026-08-18).
 *
 * A refusal is NOT a failure: see `requeueForAdmission`, which gives the claim's
 * attempt increment back so waiting cannot burn the 5-attempt dead-letter budget.
 */
export const INBOX_ORDER_BACKOFF_MS = 300;
/**
 * The ceiling is LOW on purpose. A refused row is not polling for a whole cold
 * boot any more: accepted delivery calls `promoteNextInboxRow` and makes the
 * session's next queued row due NOW, then kicks a targeted drain. The terminal
 * relay and reaper repeat that wake for recovery. This backoff only covers the
 * gap a lost kick would leave. 30s here was the entire "queue does not send
 * between turns" experience: three quick messages compounded to 27s / 45s /
 * 75s of dead air behind ~1s deliveries.
 */
export const INBOX_ORDER_MAX_BACKOFF_MS = 2_000;
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
      /** Only the first Quick Queue row may end the active turn at a tool boundary. */
      interruptAtBoundary?: { opencodeSessionId: string; messageId: string };
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
  /** The reads a `steer` row needs. Absent: a steer row is admitted as a queue row. */
  steer?: SteerAdmissionDeps;
}

/**
 * How long a queued head row may wait behind ONE live turn for the daemon's
 * boundary interrupt to end it, before the control plane ends that turn
 * itself and lets the relay promote the row.
 *
 * The interrupt is the fast path — a turn normally ends at its next tool
 * boundary, seconds after the arm. This window only bounds the interrupt's
 * silent failure modes (an entry the relay never closed, an arm the daemon
 * answers and never fires, a skipped arm): a healthy interrupt or a natural
 * turn end reaches the boundary long before it. Prod 2026-10-06: three
 * queued messages waited out a ~30-minute run with no interrupt and no
 * refusal log — the only dispatch left was "after the whole run", which is
 * the regression this bound closes.
 *
 * ponytail: fixed ceiling, not a knob; promote to config.KORTIX_* only when
 * support needs to tune it per environment.
 */
export const QUEUE_BOUNDARY_FALLBACK_MS = 10 * 60_000;

/** The turn an interrupt may end, as the admission refusal carried it. */
export interface BoundaryTurnIdentity {
  opencodeSessionId: string;
  messageId: string;
}

/** The row's own record of how long it has waited behind this turn. */
export interface BoundaryWait extends BoundaryTurnIdentity {
  sinceMs: number;
}

/**
 * Decide the boundary-wait step for one `turn_active` refusal.
 *
 * Pure over the row's result, the live turn's identity and the clock, so the
 * window is testable without a database. A first refusal starts the window;
 * the same turn still live past `QUEUE_BOUNDARY_FALLBACK_MS` aborts ONCE and
 * restarts the window (a lost terminal relay gets a bounded retry, a healthy
 * interrupt never reaches this); a DIFFERENT live turn means the boundary
 * already moved and the window restarts from now.
 */
export function boundaryWaitDecision(
  result: unknown,
  turn: BoundaryTurnIdentity,
  nowMs: number,
): { wait: BoundaryWait; abort: boolean } {
  const stored = (result as { boundary_wait?: unknown } | null | undefined)?.boundary_wait as
    | BoundaryWait
    | undefined;
  const sinceMs =
    stored && typeof stored.sinceMs === 'number' && Number.isFinite(stored.sinceMs)
      ? stored.sinceMs
      : null;
  const sameTurn =
    !!stored &&
    sinceMs !== null &&
    stored.opencodeSessionId === turn.opencodeSessionId &&
    stored.messageId === turn.messageId;
  if (!sameTurn) {
    return { wait: { ...turn, sinceMs: nowMs }, abort: false };
  }
  const waited = nowMs - sinceMs;
  return {
    wait: { ...turn, sinceMs: waited >= QUEUE_BOUNDARY_FALLBACK_MS ? nowMs : sinceMs },
    abort: waited >= QUEUE_BOUNDARY_FALLBACK_MS,
  };
}

/**
 * The live turn a boundary interrupt may end: the NEWEST stored turn.
 *
 * This used to be `turns.length === 1 ? turns[0] : null`, so one entry that
 * outlived its end relay silently DISARMED the interrupt for the whole run —
 * every queued message then waited out the turn in full, which is exactly the
 * "it waits for everything to finish" report. The newest entry is the turn
 * that is running; an older entry is a ledger leftover the reaper owns.
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
  /** The actor of the inbox row the running turn's message id names; null when no row does. */
  turnPrompter: (sessionId: string, messageId: string) => Promise<string | null>;
  /** An OLDER steer row of the session is queued or claimed (not held). */
  hasOlderSteerPrompt: (sessionId: string, row: SessionLifecycleCommandRow) => Promise<boolean>;
  recordFallback: (row: SessionLifecycleCommandRow, reason: 'unsupported' | 'not_prompter') => Promise<void>;
}

const STEER_CAPABILITY: RuntimeCapability = 'session.steer';

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
    capabilities: (externalId, actorUserId) =>
      runtimeCapabilities(externalId ?? undefined, () =>
        sandboxOpencodeEndpoint(externalId!, actorUserId ?? undefined)),
    async turnPrompter(sessionId, messageId) {
      const [prompt] = await db
        .select({ actorUserId: sessionLifecycleCommands.actorUserId })
        .from(sessionLifecycleCommands)
        .where(
          and(
            eq(sessionLifecycleCommands.sessionId, sessionId),
            eq(sessionLifecycleCommands.commandType, 'continue_session'),
            wireMessageIdMatches(messageId),
          ),
        )
        .orderBy(desc(sessionLifecycleCommands.createdAt))
        .limit(1);
      return prompt?.actorUserId ?? null;
    },
    async hasOlderSteerPrompt(sessionId, row) {
      const [older] = await db
        .select({ commandId: sessionLifecycleCommands.commandId })
        .from(sessionLifecycleCommands)
        .where(
          and(
            eq(sessionLifecycleCommands.sessionId, sessionId),
            eq(sessionLifecycleCommands.commandType, 'continue_session'),
            inArray(sessionLifecycleCommands.status, ['queued', 'running']),
            notHeldSql,
            sql`${sessionLifecycleCommands.payload}->>'delivery' = 'steer'`,
            inboxPrecedesRow(row),
            ne(sessionLifecycleCommands.commandId, row.commandId),
          ),
        )
        .limit(1);
      return !!older;
    },
    recordFallback: (row, reason) => recordSteerFallback(row, reason),
  },
};

/**
 * A `steer` row and a running turn (R10). Admitted as a steer when the turn
 * is one active turn with a message id, the runtime lists `session.steer`,
 * the row's actor is the turn's prompter (D9.3), and no OLDER steer row is
 * pending or in flight. Older Queue List rows do not block a steer.
 *
 * - A failed capability or prompter check falls back to `queue` for good
 *   (`recordFallback`) and returns `fallback`: the caller continues with the
 *   queue gate.
 * - A turn still being delivered, an unreadable capability list, or an older
 *   steer row: the row waits and stays `steer`.
 */
async function admitSteer(
  row: SessionLifecycleCommandRow,
  sandbox: { metadata: Record<string, unknown> | null; externalId?: string | null } | null,
  steer: SteerAdmissionDeps,
  retryAfterMs: number,
): Promise<InboxAdmission | 'fallback'> {
  const turns = storedSandboxTurns(sandbox?.metadata);
  // Same fragile pattern the queue interrupt had: one entry that outlived its
  // end relay would make exactly-one fail and silently park the steer behind
  // the whole run. The newest entry is the turn that is running.
  const active = newestStoredTurn(turns);
  if (active?.state !== 'active' || !active.messageId) {
    return { admit: false, reason: 'turn_active', retryAfterMs };
  }
  const sessionId = row.sessionId!;
  const [capabilities, prompter, olderSteer] = await Promise.all([
    steer.capabilities(sandbox?.externalId, row.actorUserId),
    steer.turnPrompter(sessionId, active.messageId),
    steer.hasOlderSteerPrompt(sessionId, row),
  ]);
  if (capabilities === null) return { admit: false, reason: 'turn_active', retryAfterMs };
  const fallback = !capabilities.includes(STEER_CAPABILITY)
    ? 'unsupported'
    : !row.actorUserId || prompter !== row.actorUserId
      ? 'not_prompter'
      : null;
  if (fallback) {
    await steer.recordFallback(row, fallback);
    return 'fallback';
  }
  if (olderSteer) return { admit: false, reason: 'older_prompt_pending', retryAfterMs };
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

  // A live turn holds delivery for both placements. Quick Queue may request
  // an interrupt at the next tool boundary, but it is still never forwarded
  // into that turn: the terminal relay admits it as its own turn afterward.
  let sandbox = await sandboxRead;
  const payload = row.payload as { delivery?: unknown; wireMessageId?: unknown } | null;
  if (
    deps.steer &&
    payload?.delivery === 'steer' &&
    typeof payload.wireMessageId === 'string' &&
    sessionHoldsTurnAuthority(sandbox)
  ) {
    const steered = await admitSteer(row, sandbox, deps.steer, orderBackoffMs);
    if (steered !== 'fallback') return steered;
  }
  if (sessionHoldsTurnAuthority(sandbox)) {
    // Only the head may reconcile or arm an interrupt. Quick Queue sorts ahead
    // of every Queue List row (`inbox-order.ts`), so its head arms the
    // interrupt even while older Queue List entries wait. A released Stop
    // batch row sorts in the Queue List lane whatever its placement.
    const isHead = !(await inFlightRead) && !(await olderRead);
    if (deps.reconcileTurn && isHead) {
      await deps.reconcileTurn(row.sessionId);
      sandbox = await deps.readSandbox(row.sessionId);
    }
    if (sessionHoldsTurnAuthority(sandbox)) {
      const turns = storedSandboxTurns(sandbox?.metadata);
      const active = newestStoredTurn(turns);
      const interruptAtBoundary =
        isHead &&
        (row.payload as { placement?: unknown } | null)?.placement === 'transcript' &&
        active?.state === 'active' &&
        active.messageId
          ? { opencodeSessionId: active.runtimeSessionId, messageId: active.messageId }
          : undefined;
      return {
        admit: false,
        reason: 'turn_active',
        retryAfterMs: orderBackoffMs,
        ...(interruptAtBoundary ? { interruptAtBoundary } : {}),
      };
    }
  }

  // ONE PROMPT OF A SESSION ON THE WIRE AT A TIME, and this check binds even a
  // promoted row. A claimed row spends up to READY_DEADLINE_MS (5 min) inside
  // `continueSession` waiting for a cold box, with no message written for any
  // of it. Admitting a second prompt into that window races two deliveries of
  // one session, and OpenCode orders what it receives by ARRIVAL — so the loser
  // of that race is the message the user typed FIRST.
  if (await inFlightRead) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  // "Send now"/retry stamps `promoted`: the user pointed at ONE row and asked
  // for THAT message. QUEUE ORDER yields to that; the in-flight check above
  // does not, because it is about a delivery already happening rather than
  // about which message goes first.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  if (!promoted && (await olderRead)) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
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
