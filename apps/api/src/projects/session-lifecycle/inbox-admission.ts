import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { RUNNING_SANDBOX_STATUSES, storedSandboxTurns } from '../sandbox-turn-lifecycle';
import type { SessionLifecycleCommandRow } from './store';

/**
 * The inbox's admission gate.
 *
 * A prompt sits in `session_lifecycle_commands` until the session can actually
 * take it. Two things stop it, and both are read from server truth rather than
 * inferred from a client's idea of "busy":
 *
 *  1. The session already holds LIVE TURN AUTHORITY. Delivering into a running
 *     turn is what OpenCode answers by aborting the turn in progress, so the
 *     prompt waits.
 *  2. An OLDER prompt for the same session is still pending. `claimDueLifecycleCommands`
 *     orders globally by `available_at, created_at`, which does not order the
 *     rows of ONE session against each other under retries and backoffs. A
 *     younger row that wins the claim simply refuses admission and puts itself
 *     back — which is cheaper and safer than a per-session claim lock.
 *
 * A refusal is NOT a failure: see `requeueForAdmission`, which gives the claim's
 * attempt increment back so waiting cannot burn the 5-attempt dead-letter budget.
 */
/**
 * The two backoffs are ORDERED, and the order is the point.
 *
 * `claimDueLifecycleCommands` claims globally by `available_at ASC` with one
 * shared per-tick budget. The row blocked by the live turn is always the OLDEST
 * of its session — and the only one that can ever be admitted. If it came due
 * AFTER the rows queued behind it, every batch would fill with followers that
 * can only refuse again, and the head would never be claimed at all: nothing
 * would be delivered while the pattern held. So the head backs off SHORTER than
 * its followers, always.
 */
export const INBOX_TURN_ACTIVE_BACKOFF_MS = 1_000;
export const INBOX_ORDER_BACKOFF_MS = 3_000;
/**
 * And they GROW, because a refusal costs a claim from a SHARED budget.
 *
 * `drainSessionLifecycleQueue({ limit: 10 })` on the scheduler tick is the only
 * unbounded drain, and it also carries `create_session`, trigger callbacks and
 * approval-resume. A prompt refused every second spends one of those ten slots
 * every second for as long as its turn runs, so a few dozen people typing ahead
 * anywhere in the fleet is enough to starve the lane — and because the claim
 * orders by `available_at ASC`, the overdue refusals sort AHEAD of the fresh
 * work they starved.
 *
 * The first few refusals do NOT grow, and that part is user-visible: the head's
 * backoff IS the dead air between a turn ending and the next prompt going out,
 * so an ordinary short turn must still be picked up within a second. Only a
 * prompt that has already been waiting past `INBOX_BACKOFF_FREE_REFUSALS`
 * — i.e. behind a genuinely long turn — starts costing less.
 *
 * Both curves share one exponent, so the ordering invariant above holds at
 * every refusal count: a follower always comes due 3x later than its head.
 */
export const INBOX_TURN_ACTIVE_MAX_BACKOFF_MS = 10_000;
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

export type InboxAdmissionReason = 'turn_active' | 'older_prompt_pending';

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
 */
export function sessionHoldsTurnAuthority(
  box: { status: string; metadata: Record<string, unknown> | null } | null,
): boolean {
  return (
    !!box && RUNNING_SANDBOX_STATUSES.has(box.status) && storedSandboxTurns(box.metadata).length > 0
  );
}

export interface InboxAdmissionDeps {
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
    // `session_sandboxes.session_id` is UNIQUE, so this is the session's one
    // box. Served by idx_session_sandboxes_session.
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

export async function admitInboxPrompt(
  row: SessionLifecycleCommandRow,
  deps: InboxAdmissionDeps = liveDeps,
): Promise<InboxAdmission> {
  // A row with no session cannot be ordered or gated. Admit it so the drain
  // reaches its own honest failure instead of requeueing it for ever.
  if (!row.sessionId) return { admit: true };

  const refusals = admissionRefusals(row.result);

  const box = await deps.readSandbox(row.sessionId);
  if (sessionHoldsTurnAuthority(box)) {
    return {
      admit: false,
      reason: 'turn_active',
      retryAfterMs: admissionBackoffMs(
        INBOX_TURN_ACTIVE_BACKOFF_MS,
        INBOX_TURN_ACTIVE_MAX_BACKOFF_MS,
        refusals,
      ),
    };
  }

  const orderBackoffMs = admissionBackoffMs(
    INBOX_ORDER_BACKOFF_MS,
    INBOX_ORDER_MAX_BACKOFF_MS,
    refusals,
  );

  // ONE PROMPT OF A SESSION ON THE WIRE AT A TIME, and this check binds even a
  // promoted row. Turn authority above cannot stand in for it: a claimed row
  // spends up to READY_DEADLINE_MS (5 min) inside `continueSession` waiting for
  // a cold box, and no turn exists for ANY of that time. Admitting a second
  // prompt into that window puts two deliveries on the wire, and the second
  // aborts the turn the first is about to start.
  if (await deps.hasInFlightPrompt(row.sessionId, row.commandId)) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  // "Send now"/retry stamps `promoted`: the user pointed at ONE row, and paid
  // for it by interrupting the turn. QUEUE ORDER yields to that; turn authority
  // and the in-flight check above do not, because both are about a delivery
  // already happening rather than about which message goes first.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  if (
    !promoted &&
    (await deps.hasOlderPendingPrompt(row.sessionId, row.createdAt, row.commandId))
  ) {
    return { admit: false, reason: 'older_prompt_pending', retryAfterMs: orderBackoffMs };
  }

  return { admit: true };
}
