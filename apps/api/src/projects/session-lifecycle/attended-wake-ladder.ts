/**
 * The wake ladder, run by the server for a session somebody watches (R5.2).
 *
 * A wake that goes QUIET is escalated through the steps a person would take:
 * re-drive the start, then restart, at most {@link WAKE_MAX_RESTARTS} times. A
 * wake that shows progress is never escalated, however long it takes. Until
 * R5 every open tab ran this ladder itself (`@kortix/sdk`
 * `core/session/wake-escalation.ts`) from its own `/kortix/health` probe, so two
 * tabs could each restart the box. Now the control reconciler runs it once:
 *
 *  - The SILENCE clock is per replica, fed by what the replica observes: the
 *    box row (status, wake provider status, wake progress, stop reason), the
 *    attach reason of its `/events` streams, and the harness state.
 *  - The BUDGET is in the box row (`metadata.wakeLadder`), claimed under
 *    `FOR UPDATE`, so two replicas never spend one step twice.
 *  - The ladder only acts for a watcher allowed to restart the session; a
 *    read-only viewer sees its state but never triggers it.
 *  - The episode ends, and the budget resets, the moment the runtime answers.
 *    A box that drops after it answered is not a wake and is not restarted.
 */
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

/** Silence after which the ladder escalates. Same value the client used. */
export const WAKE_NO_PROGRESS_MS = 75_000;
/** Restarts per episode. The human fix that always works is one restart. */
export const WAKE_MAX_RESTARTS = 2;
/** Minimum gap between two steps, so a restart can produce its first signal. */
export const WAKE_ESCALATION_COOLDOWN_MS = 20_000;

export type WakeLadderStep = 'none' | 'retry-start' | 'restart' | 'exhausted';

/** The episode's spent budget, stored in `session_sandboxes.metadata.wakeLadder`. */
export interface WakeLadderBudget {
  retried: boolean;
  restarts: number;
  lastActionMs: number | null;
}

export interface WakeLadderObservation {
  /** How long nothing the server observes has changed. */
  silentMs: number;
  /** The server already declared this wake failed (`runtime_wake_failed`). */
  serverGaveUp: boolean;
  nowMs: number;
}

/** Pure: the step to take now. `exhausted` once every step is spent. */
export function nextWakeLadderStep(
  observation: WakeLadderObservation,
  budget: WakeLadderBudget,
): WakeLadderStep {
  const due = observation.serverGaveUp || observation.silentMs >= WAKE_NO_PROGRESS_MS;
  if (!due) return 'none';
  if (budget.retried && budget.restarts >= WAKE_MAX_RESTARTS) return 'exhausted';
  if (
    budget.lastActionMs !== null &&
    observation.nowMs - budget.lastActionMs < WAKE_ESCALATION_COOLDOWN_MS
  ) {
    return 'none';
  }
  return budget.retried ? 'restart' : 'retry-start';
}

function readBudget(metadata: Record<string, unknown> | null | undefined): WakeLadderBudget {
  const raw = (metadata?.wakeLadder ?? null) as Record<string, unknown> | null;
  return {
    retried: raw?.retried === true,
    restarts: typeof raw?.restarts === 'number' ? raw.restarts : 0,
    lastActionMs: typeof raw?.last_action_ms === 'number' ? raw.last_action_ms : null,
  };
}

/** The stored budget of a box row, for the control frame. */
export function wakeLadderBudgetOf(metadata: Record<string, unknown> | null | undefined): WakeLadderBudget {
  return readBudget(metadata);
}

/**
 * Atomically decide and spend one step. Two replicas racing the same box
 * serialize on the row lock; the second sees the first's step and its cooldown.
 * Returns the step this caller now owns (`none` when another replica took it).
 */
export async function claimWakeLadderStep(
  sessionId: string,
  observation: WakeLadderObservation,
): Promise<{ step: WakeLadderStep; budget: WakeLadderBudget }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .for('update')
      .limit(1);
    const budget = readBudget(row?.metadata);
    const step = row ? nextWakeLadderStep(observation, budget) : 'none';
    if (step !== 'retry-start' && step !== 'restart') return { step, budget };
    const next: WakeLadderBudget = {
      retried: true,
      restarts: budget.restarts + (step === 'restart' ? 1 : 0),
      lastActionMs: observation.nowMs,
    };
    await tx
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({
          wakeLadder: { retried: next.retried, restarts: next.restarts, last_action_ms: next.lastActionMs },
        })}::jsonb`,
      })
      .where(eq(sessionSandboxes.sessionId, sessionId));
    return { step, budget: next };
  });
}

/** The runtime answered: end the episode so the next wake starts a fresh budget. */
export async function resetWakeLadder(sessionId: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({ metadata: sql`${sessionSandboxes.metadata} - 'wakeLadder'` })
    .where(
      sql`${sessionSandboxes.sessionId} = ${sessionId} AND ${sessionSandboxes.metadata} ? 'wakeLadder'`,
    );
}
