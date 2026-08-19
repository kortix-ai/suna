import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { RUNNING_SANDBOX_STATUSES, storedSandboxTurns } from '../sandbox-turn-lifecycle';
import type { SessionLifecycleCommandRow } from './store';

/**
 * The inbox's admission gate.
 *
 * A prompt sits in `session_lifecycle_commands` only until it is this session's
 * TURN TO BE SENT — not until the session is idle. A live turn does NOT hold a
 * prompt back: OpenCode persists a mid-turn prompt and runs it in ARRIVAL order
 * once the turn in flight ends (proven against a real sandbox in
 * `src/__tests__/integration-inbox-midturn-forward.test.ts`), so waiting bought
 * nothing and cost up to 10s of dead air on every send.
 *
 * What is left is ORDER, and only order: `claimDueLifecycleCommands` claims
 * globally by `available_at, created_at`, which does not order the rows of ONE
 * session against each other under retries and backoffs. Because OpenCode
 * queues by arrival, two concurrent forwards of one session would put the
 * user's own messages on the wire out of the order they typed them. A younger
 * row that wins the claim simply refuses admission and puts itself back — which
 * is cheaper and safer than a per-session claim lock.
 *
 * A refusal is NOT a failure: see `requeueForAdmission`, which gives the claim's
 * attempt increment back so waiting cannot burn the 5-attempt dead-letter budget.
 */
/**
 * How long a row that lost the ordering race waits before trying again.
 *
 * With the turn-active refusal gone this backoff is the ONLY dead air left in a
 * send, so the first refusals are deliberately cheap: the sibling this row is
 * waiting for is a `running` row, and on an awake box that row completes in
 * milliseconds — four free refusals at 500ms cover it without a visible pause.
 *
 * It still GROWS, because a refusal costs a claim from a SHARED budget.
 * `drainSessionLifecycleQueue({ limit: 10 })` on the scheduler tick is the only
 * unbounded drain, and it also carries `create_session`, trigger callbacks and
 * approval-resume. The sibling can legitimately hold the wire for a whole
 * READY_DEADLINE_MS cold boot (5 min), and a row re-claiming a slot twice a
 * second for that long starves the lane — the claim orders by `available_at
 * ASC`, so the overdue refusals then sort AHEAD of the fresh work they starved.
 * The exponential reaches the 30s ceiling well inside that boot.
 */
export const INBOX_ORDER_BACKOFF_MS = 500;
export const INBOX_ORDER_MAX_BACKOFF_MS = 30_000;
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

/** The one thing that still holds a prompt back. Kept as a union because it is
 *  written into `result.admission_reason` and served as `GET .../prompts`'
 *  `reason`, where a second value may well appear again. */
export type InboxAdmissionReason = 'older_prompt_pending';

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
 * ADMISSION NO LONGER READS THIS — a live turn does not hold a prompt back. It
 * stays here, and stays exported, because `GET .../turn` and
 * `settleOrphanedSandboxTurns` share the status filter and would drift apart if
 * each re-expressed it, and because the DRAIN still asks the question for a
 * different purpose — see `sessionHoldsLiveTurn` below.
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
 * ADMISSION still does not ask it — a live turn no longer holds a prompt back.
 * The DRAIN does, and for a different reason: a prompt delivered into a live
 * turn has to be re-minted first, because the turn has been writing higher wire
 * ids ever since it started and OpenCode reads a lower id as already answered.
 * See `executeQueuedContinue`.
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

export async function admitInboxPrompt(
  row: SessionLifecycleCommandRow,
  deps: InboxAdmissionDeps = liveDeps,
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

  // ONE PROMPT OF A SESSION ON THE WIRE AT A TIME, and this check binds even a
  // promoted row. A claimed row spends up to READY_DEADLINE_MS (5 min) inside
  // `continueSession` waiting for a cold box, with no message written for any
  // of it. Admitting a second prompt into that window races two deliveries of
  // one session, and OpenCode orders what it receives by ARRIVAL — so the loser
  // of that race is the message the user typed FIRST.
  if (await deps.hasInFlightPrompt(row.sessionId, row.commandId)) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  // "Send now"/retry stamps `promoted`: the user pointed at ONE row and asked
  // for THAT message. QUEUE ORDER yields to that; the in-flight check above
  // does not, because it is about a delivery already happening rather than
  // about which message goes first.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  if (
    !promoted &&
    (await deps.hasOlderPendingPrompt(row.sessionId, row.createdAt, row.commandId))
  ) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  return { admit: true };
}
