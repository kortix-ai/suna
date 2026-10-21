import { projectSessions, projectTriggerExecutions, projectTriggerRuntime } from '@kortix/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { classifyTurnError } from '../../channels/slack/errors';
import { projectNotificationsEnabled } from '../../notifications/enabled';
import { notifySessionPushLegacy } from '../../notifications/session-push-legacy';
import { db } from '../../shared/db';
import { resolveProjectAutomationActor } from '../session-lifecycle/actor';
import { ABORT_END_ERROR_NAMES, isRequestedStopName, type SandboxTurnCompletionOutcome } from '../session-turn-ledger';
import { clearTriggerAlert, raiseTriggerAlert } from './trigger-alerts';

/**
 * A trigger's runtime row records whether its prompt was DELIVERED
 * (`last_status` queued → fired, or failed on dead-letter). The model turn
 * that runs afterwards never wrote back. On 2026-09-30 a reused trigger
 * session failed every run for hours, and the trigger still read `fired`.
 * Its turn-end push went to the agent's service account, so nobody was told.
 *
 * At the end of a turn in a session a trigger created, this records the run's
 * outcome on the trigger:
 * - failed: `last_status: failed`, the reason in `last_error`, and
 *   `run_failing_since`. The trigger's watchers get one `automation_failed`
 *   alert per streak (trigger-alerts.ts). With the project's
 *   `notification_center` flag off, the account owner (whom triggers run as)
 *   gets one push when the streak starts instead, as before KRTX-1742. Later
 *   fires keep `failed` (keepRunFailure);
 * - succeeded after failed runs: back to `fired`, error and streak cleared;
 *   the watchers get one `automation_recovered` alert (flag on only);
 * - failed because the history no longer fits the model even after
 *   compaction: the session is retired, so the next reuse/keyed fire starts
 *   a fresh session instead of failing into the same one.
 */

/** Set on a trigger session that can no longer run; reuse lookups skip it. */
export const TRIGGER_REUSE_RETIRED_AT = 'trigger_reuse_retired_at';

export interface TriggerRunEnd {
  projectId: string;
  accountId: string;
  sessionId: string;
  /** `project_sessions.metadata`: a trigger-created session carries trigger_kind/trigger_slug. */
  metadata: Record<string, unknown>;
  status: 'idle' | 'error';
  error?: { name?: string; message?: string } | null;
  outcome: SandboxTurnCompletionOutcome;
  childSession: boolean;
  now?: Date;
}

export type TriggerRunEndResult = 'failed' | 'still_failed' | 'recovered' | 'unchanged' | 'not_a_trigger_run';

/** The trigger that created this session, or null for any other session. */
export function triggerSlugOf(metadata: Record<string, unknown>): string | null {
  const slug = metadata.trigger_slug;
  return metadata.trigger_kind === 'git' && typeof slug === 'string' && slug.length > 0 ? slug : null;
}

/** `<category>: <reason>`, e.g. "Out of credits: Payment Required: Insufficient credits." */
export function triggerRunFailureText(error: { name?: string; message?: string } | null | undefined): string {
  const { title } = classifyTurnError(error ?? undefined);
  const reason = error?.message?.trim() || error?.name || 'No reason was reported.';
  return `${title}: ${reason}`.slice(0, 1000);
}

/** Why a run failed when its turn ended without a model error. */
const RUN_ERROR_BY_END_REASON: Record<string, string> = {
  abandoned: 'The prompt never reached the agent.',
  runtime_gone: 'The sandbox stopped before the turn ended.',
  unknown: 'The turn ended without an outcome.',
};

type EndedTurn = { end_reason: string | null; end_error: { name?: string | null; message?: string | null } | null };
type EndedRunTurn = EndedTurn & { execution_id: string; ended_at: string | Date | null };

function runOutcomeOf(turn: EndedTurn): { runStatus: 'succeeded' | 'failed'; runError: string | null } {
  if (turn.end_reason === 'completed') return { runStatus: 'succeeded', runError: null };
  const name = turn.end_error?.name ?? '';
  if (ABORT_END_ERROR_NAMES.includes(name) || isRequestedStopName(name)) return { runStatus: 'failed', runError: 'stopped' };
  if (turn.end_reason !== 'failed') {
    return { runStatus: 'failed', runError: RUN_ERROR_BY_END_REASON[turn.end_reason ?? ''] ?? RUN_ERROR_BY_END_REASON.unknown! };
  }
  return {
    runStatus: 'failed',
    runError: triggerRunFailureText({ name: turn.end_error?.name ?? undefined, message: turn.end_error?.message ?? undefined }),
  };
}

/**
 * Close every open run whose turn has ended, from the turn ledger
 * (`session_turns`). A run's turn is the first turn of its session that
 * started at or after the fire. Queued prompts run one turn each, in order,
 * so each fire gets its own turn's outcome. Returns the runs closed.
 *
 * The ledger, not the terminal relay, is the truth: a turn also ends through
 * the reaper, a stop, a box that went away, or a relay that arrives after
 * another path settled it (`already_closed`). Closing a run only on a
 * `closed` relay left it "Running" for good, and the next fire's turn end
 * then closed it with the wrong outcome (prod, 2026-10-21).
 *
 * The match is by session only: a pinned trigger's or a reminder's session
 * carries no trigger metadata, and its runs must close too. Without
 * `sessionId` it settles every project (the maintenance backstop).
 */
export async function settleTriggerRunsFromTurns(sessionId?: string): Promise<number> {
  const ended = await db.execute<EndedRunTurn>(sql`
    SELECT r.execution_id, t.end_reason, t.end_error, t.ended_at
      FROM kortix.project_trigger_executions r
      CROSS JOIN LATERAL (
        SELECT st.state, st.end_reason, st.end_error, st.ended_at
          FROM kortix.session_turns st
         WHERE st.session_id = r.session_id
           AND st.started_at >= coalesce(r.claimed_at, r.created_at)
         ORDER BY st.started_at
         LIMIT 1) t
     WHERE r.run_status = 'running'
       AND r.run_ended_at IS NULL
       ${sessionId ? sql`AND r.session_id = ${sessionId}` : sql``}
       AND t.state = 'ended'
     LIMIT 500`);
  const rows = (ended as unknown as { rows?: EndedRunTurn[] }).rows ?? ended;
  let closed = 0;
  for (const row of rows as EndedRunTurn[]) {
    const endedAt = row.ended_at ? new Date(row.ended_at) : new Date();
    const updated = await db
      .update(projectTriggerExecutions)
      .set({ ...runOutcomeOf(row), runEndedAt: endedAt, updatedAt: new Date() })
      .where(
        and(
          eq(projectTriggerExecutions.executionId, row.execution_id),
          eq(projectTriggerExecutions.runStatus, 'running'),
          isNull(projectTriggerExecutions.runEndedAt),
        ),
      )
      .returning({ executionId: projectTriggerExecutions.executionId });
    closed += updated.length;
  }
  return closed;
}

export async function recordTriggerRunEnd(
  end: TriggerRunEnd,
  legacyPush: typeof notifySessionPushLegacy = notifySessionPushLegacy,
): Promise<TriggerRunEndResult> {
  // A subagent's turn and a retry say nothing about any run.
  if (end.childSession || end.outcome === 'non_terminal') return 'not_a_trigger_run';
  // Every terminal relay settles the session's runs from the ledger, which
  // the relay already wrote: a replay cannot close a run whose turn is open.
  // The run closes before the slug check: pinned and reminder sessions have no trigger metadata.
  await settleTriggerRunsFromTurns(end.sessionId);
  // Only a turn this call genuinely closed is a trigger outcome.
  if (end.outcome !== 'closed') return 'not_a_trigger_run';
  const now = end.now ?? new Date();
  const aborted = end.status === 'error' && ABORT_END_ERROR_NAMES.includes(end.error?.name ?? '');
  const slug = triggerSlugOf(end.metadata);
  // A stopped turn ends its run, but says nothing about the trigger.
  if (!slug || aborted) return 'not_a_trigger_run';
  const row = and(eq(projectTriggerRuntime.projectId, end.projectId), eq(projectTriggerRuntime.slug, slug));

  if (end.status === 'idle') {
    const recovered = await db
      .update(projectTriggerRuntime)
      .set({ lastStatus: 'fired', lastError: null, runFailingSince: null, lastAttemptAt: now, updatedAt: now })
      // A failed fire is cleared by the next good fire, not by another fire's run.
      .where(and(row, isNotNull(projectTriggerRuntime.runFailingSince)))
      .returning({ slug: projectTriggerRuntime.slug });
    // Every finished run ends a run-failure alert, even one whose display
    // state an earlier fire already reset.
    await clearTriggerAlert({ projectId: end.projectId, accountId: end.accountId, slug, source: 'run' });
    return recovered.length > 0 ? 'recovered' : 'unchanged';
  }

  // OpenCode compacts on overflow by itself. ContextOverflowError as the
  // turn's end means compaction failed: this session can never run again.
  if (end.error?.name === 'ContextOverflowError') {
    await db
      .update(projectSessions)
      .set({
        metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object(${TRIGGER_REUSE_RETIRED_AT}::text, ${now.toISOString()}::text)`,
      })
      .where(eq(projectSessions.sessionId, end.sessionId));
  }

  const lastError = triggerRunFailureText(end.error);
  // One statement starts the streak: concurrent ends of two runs cannot both
  // see it unset, so a flag-off owner is pushed once per streak.
  const transitioned = await db
    .update(projectTriggerRuntime)
    .set({ lastStatus: 'failed', lastError, runFailingSince: now, lastAttemptAt: now, updatedAt: now })
    .where(and(row, isNull(projectTriggerRuntime.runFailingSince)))
    .returning({ slug: projectTriggerRuntime.slug });
  let result: TriggerRunEndResult = 'failed';
  if (transitioned.length === 0) {
    const refreshed = await db
      .update(projectTriggerRuntime)
      .set({ lastStatus: 'failed', lastError, lastAttemptAt: now, updatedAt: now })
      .where(row)
      .returning({ slug: projectTriggerRuntime.slug });
    result = refreshed.length > 0 ? 'still_failed' : 'unchanged';
  }
  if (!(await projectNotificationsEnabled(end.projectId))) {
    if (transitioned.length === 0) return result;
    // The identity every trigger runs as. `owner_user_id` is deprecated and
    // ignored (integration-trigger-actor.test.ts): it may name a stale human.
    const owner = await resolveProjectAutomationActor(end.accountId);
    if (owner) {
      await legacyPush({ type: 'error', sessionId: end.sessionId, projectId: end.projectId, recipients: [owner] });
    }
    return result;
  }
  // Every failed run tries: the alert edge is separate from the display
  // streak, and a fire alert that cleared meanwhile must not hide this one.
  await raiseTriggerAlert({ projectId: end.projectId, accountId: end.accountId, slug, source: 'run', error: lastError, notificationCenter: true });
  return result;
}
