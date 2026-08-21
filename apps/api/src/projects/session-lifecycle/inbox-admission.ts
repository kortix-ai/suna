import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { RUNNING_SANDBOX_STATUSES, storedSandboxTurns } from '../sandbox-turn-lifecycle';
import type { SessionLifecycleCommandRow } from './store';

/**
 * The inbox's admission gate.
 *
 * THE INBOX OWNS THE QUEUE. A prompt stays a durable row — listed, ordered,
 * visible and removable — until the runtime is actually free, and only then is
 * it delivered. One prompt of a session on the wire at a time, oldest first.
 *
 * Forwarding into a LIVE turn was the alternative, and it is what made the
 * queue uncontrollable. OpenCode parents each STEP on the newest user message,
 * so a prompt handed over mid-turn is adopted by the running turn almost at
 * once. MEASURED 2026-08-21 against a real sandbox: a prompt queued behind a
 * running turn read `delivering` within one request of being posted, and
 * `DELETE .../prompts/:id` then answered 409 "Prompt is already being
 * answered" — the Remove button was dead in the only situation anyone would
 * use it. The row also left `GET .../prompts` at acceptance, so the queue could
 * not be rendered honestly either, and placing a message inside someone else's
 * turn needed a whole clock-skew id-minting layer plus a strand reconciler to
 * repair what it broke.
 *
 * The cost is deliberate and known: a batch of queued prompts is no longer
 * folded into ONE model step. Each gets its own turn, in the order it was sent.
 * That is the trade for a queue the user can actually see and control.
 *
 * WAITING IS NOT POLLING. A refused row does not sit out a backoff clock: the
 * instant the blocking delivery lands (engine) or a turn ends (turn-stream),
 * `promoteNextInboxRow` makes the session's next row due and drains it. The
 * backoff below only covers the gap a lost kick would leave, so it stays cheap
 * and capped — 30s here compounded to 27s / 45s / 75s of dead air behind ~1s
 * deliveries (dev, 2026-08-18).
 *
 * A refusal is NOT a failure: see `requeueForAdmission`, which gives the claim's
 * attempt increment back so waiting cannot burn the 5-attempt dead-letter budget.
 */
export const INBOX_ORDER_BACKOFF_MS = 300;
/**
 * The ceiling is LOW on purpose. A refused row is not polling for a whole cold
 * boot any more: the moment its sibling lands, `promoteNextInboxRow` (engine)
 * makes the session's next queued row due NOW and kicks a targeted drain, so
 * this backoff only ever covers the gap a lost kick would leave. 30s here was
 * the entire "queue does not send between turns" experience: three quick
 * messages compounded to 27s / 45s / 75s of dead air behind ~1s deliveries.
 */
export const INBOX_ORDER_MAX_BACKOFF_MS = 2_000;
export const INBOX_BACKOFF_FREE_REFUSALS = 4;

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

/** Why a prompt is still sitting in the inbox. Written into
 *  `result.admission_reason` and served as `GET .../prompts`' `reason`. */
export type InboxAdmissionReason = 'older_prompt_pending' | 'turn_active';

export type InboxAdmission =
  | { admit: true }
  | { admit: false; reason: InboxAdmissionReason; retryAfterMs: number };

/**
 * Does this session hold live turn authority right now?
 *
 * Exactly the predicate `GET /sessions/{id}/turn` serves from: the lifecycle
 * authority is `session_sandboxes.metadata.activeTurns` READ AGAINST A RUNNING
 * BOX. Metadata outlives the runtime, so a stopped box holds nothing whatever
 * its metadata still says. Pure over the two fields, so the truth table is
 * testable without a database.
 *
 * ADMISSION READS THIS: it is the hold. `GET .../turn` and
 * `settleOrphanedSandboxTurns` share the same predicate so they cannot drift.
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
 * Admission uses the in-process `deps.readSandbox` form; this one serves the
 * drain, which asks the same question on its own path.
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
  /** The session's one sandbox row — its `metadata.activeTurns` is the turn
   *  authority `sessionHoldsTurnAuthority` reads. */
  readSandbox: (
    sessionId: string,
  ) => Promise<{ status: string; metadata: Record<string, unknown> | null } | null>;
  hasOlderPendingPrompt: (
    sessionId: string,
    before: Date,
    exceptCommandId: string,
  ) => Promise<boolean>;
  /** Is another prompt of this session ALREADY CLAIMED and mid-delivery?
   *  Separate from the ordering read because it binds even a promoted row. */
  hasInFlightPrompt: (sessionId: string, exceptCommandId: string) => Promise<boolean>;
}

const liveDeps: InboxAdmissionDeps = {
  async readSandbox(sessionId) {
    const [box] = await db
      .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);
    return box ?? null;
  },
  async hasOlderPendingPrompt(sessionId, before, exceptCommandId) {
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
          sql`COALESCE(${sessionLifecycleCommands.result}->>'held', '') <> 'true'`,
          lt(sessionLifecycleCommands.createdAt, before),
          // Explicitly not itself. `created_at < created_at` already excludes
          // this row, but the caller's `before` comes from an in-memory copy of
          // it — one that a concurrent writer can have moved — and a row that
          // blocks on itself waits for ever.
          ne(sessionLifecycleCommands.commandId, exceptCommandId),
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
};

export interface AdmitInboxPromptOptions {
  /**
   * This row is being delivered as part of its session's own claimed batch.
   *
   * Skips the ORDER checks only. The lane claimed every due row of the session
   * together and delivers them in order, so "is an older prompt of this session
   * pending?" would refuse a row for the very siblings it is going out with.
   *
   * It does NOT skip the live-turn hold. That gate is about the RUNTIME being
   * free, which a batch cannot change, and letting the batch lane past it is
   * what still delivered a queued prompt into a running turn after the hold
   * was added.
   */
  batch?: boolean;
}

export async function admitInboxPrompt(
  row: SessionLifecycleCommandRow,
  deps: InboxAdmissionDeps = liveDeps,
  options: AdmitInboxPromptOptions = {},
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

  // THE HOLD, and it is checked FIRST because it binds every lane. A live turn
  // keeps every prompt in the inbox — including a promoted one ("send now"
  // decides which message goes first, it cannot make the runtime free) and
  // including a batch member (the batch bypass is about ORDER, and a batch
  // cannot free the runtime either). Released by the turn ending: `turn-stream`
  // `end` closes the ledger row and kicks `promoteNextInboxRow`, so this is a
  // state change and not a poll.
  if (sessionHoldsTurnAuthority(await deps.readSandbox(row.sessionId))) {
    return { admit: false, reason: 'turn_active', retryAfterMs: orderBackoffMs };
  }

  // ONE PROMPT OF A SESSION ON THE WIRE AT A TIME, and this check binds even a
  // promoted row. A claimed row spends up to READY_DEADLINE_MS (5 min) inside
  // `continueSession` waiting for a cold box, with no message written for any
  // of it. Admitting a second prompt into that window races two deliveries of
  // one session, and OpenCode orders what it receives by ARRIVAL — so the loser
  // of that race is the message the user typed FIRST.
  if (!options.batch && (await deps.hasInFlightPrompt(row.sessionId, row.commandId))) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  // "Send now"/retry stamps `promoted`: the user pointed at ONE row and asked
  // for THAT message. QUEUE ORDER yields to that; the in-flight check above
  // does not, because it is about a delivery already happening rather than
  // about which message goes first.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  if (
    !options.batch &&
    !promoted &&
    (await deps.hasOlderPendingPrompt(row.sessionId, row.createdAt, row.commandId))
  ) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  return { admit: true };
}
