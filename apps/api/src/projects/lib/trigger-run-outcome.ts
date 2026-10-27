import { projectSessions, projectTriggerExecutions, projectTriggerRuntime, sessionTurns } from '@kortix/db';
import { and, asc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
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

/** A run whose prompt never started a turn fails after this long. */
const RUN_WITHOUT_TURN_MS = 6 * 60 * 60_000;

/** Which ledger row of one prompt names its outcome: a real end beats a lost delivery. */
const END_REASON_RANK = ['completed', 'failed', 'runtime_gone', 'unknown', 'abandoned'];

type TurnEnd = { endReason: string | null; endError: { name?: string | null; message?: string | null } | null };

function runOutcomeOf(turn: TurnEnd): { runStatus: 'succeeded' | 'failed'; runError: string | null } {
  if (turn.endReason === 'completed') return { runStatus: 'succeeded', runError: null };
  const name = turn.endError?.name ?? '';
  if (ABORT_END_ERROR_NAMES.includes(name) || isRequestedStopName(name)) return { runStatus: 'failed', runError: 'stopped' };
  if (turn.endReason !== 'failed') {
    return { runStatus: 'failed', runError: RUN_ERROR_BY_END_REASON[turn.endReason ?? ''] ?? RUN_ERROR_BY_END_REASON.unknown! };
  }
  return {
    runStatus: 'failed',
    runError: triggerRunFailureText({ name: turn.endError?.name ?? undefined, message: turn.endError?.message ?? undefined }),
  };
}

/** One prompt's turn: the ledger can hold two rows for it, a few ms apart, with one message id. */
interface PromptTurn extends TurnEnd {
  tokens: string[];
  startedAt: Date;
  endedAt: Date | null;
}

function promptTurns(rows: Array<typeof sessionTurns.$inferSelect>): PromptTurn[] {
  const byKey = new Map<string, Array<typeof sessionTurns.$inferSelect>>();
  for (const row of rows) {
    const key = row.messageId ?? row.turnToken;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey.values()]
    .map((group) => {
      const open = group.some((row) => row.state !== 'ended');
      const decisive = [...group].sort(
        (a, b) => END_REASON_RANK.indexOf(a.endReason ?? '') - END_REASON_RANK.indexOf(b.endReason ?? ''),
      )[0]!;
      const endedAt = Math.max(...group.map((row) => row.endedAt?.getTime() ?? 0));
      return {
        tokens: group.map((row) => row.turnToken),
        startedAt: group[0]!.startedAt,
        endedAt: open ? null : new Date(endedAt),
        endReason: decisive.endReason,
        endError: decisive.endError,
      };
    })
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

/**
 * Close the open runs of one session from its turn ledger (`session_turns`).
 * Runs and turns pair in order: each run takes the first turn that started
 * at or after its fire and that no earlier run took, and a turn closes one
 * run only (`run_turn_token`). Queued prompts run one turn each, in order, so
 * two fires that land before the first prompt starts still get one turn each.
 * A run waits while its turn is open, and so does every later run.
 */
async function settleSessionRuns(sessionId: string): Promise<number> {
  const t = projectTriggerExecutions;
  const runStart = sql<Date>`coalesce(${t.claimedAt}, ${t.createdAt})`.mapWith(t.createdAt);
  const open = await db
    .select({ executionId: t.executionId, startedAt: runStart })
    .from(t)
    .where(and(eq(t.sessionId, sessionId), eq(t.runStatus, 'running'), isNull(t.runEndedAt)))
    .orderBy(runStart, t.executionId);
  if (open.length === 0) return 0;
  const [rows, taken] = await Promise.all([
    db
      .select()
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), gte(sessionTurns.startedAt, open[0]!.startedAt)))
      .orderBy(asc(sessionTurns.startedAt), asc(sessionTurns.turnToken)),
    db
      .select({ token: t.runTurnToken })
      .from(t)
      .where(and(eq(t.sessionId, sessionId), isNotNull(t.runTurnToken))),
  ]);
  const takenTokens = new Set(taken.map((row) => row.token));
  const turns = promptTurns(rows).filter((turn) => !turn.tokens.some((token) => takenTokens.has(token)));
  let closed = 0;
  let next = 0;
  for (const run of open) {
    // A turn that started before this fire is not its turn: a person's prompt.
    while (next < turns.length && turns[next]!.startedAt < run.startedAt) next += 1;
    const turn = turns[next];
    if (!turn?.endedAt) break;
    next += 1;
    const updated = await db
      .update(t)
      .set({ ...runOutcomeOf(turn), runEndedAt: turn.endedAt, runTurnToken: turn.tokens[0]!, updatedAt: new Date() })
      .where(and(eq(t.executionId, run.executionId), eq(t.runStatus, 'running'), isNull(t.runEndedAt)))
      .returning({ executionId: t.executionId });
    closed += updated.length;
  }
  return closed;
}

/**
 * Close every open run whose turn has ended, from the turn ledger. Returns
 * the runs closed.
 *
 * The ledger, not the terminal relay, is the truth: a turn also ends through
 * the reaper, a stop, a box that went away, or a relay that arrives after
 * another path settled it (`already_closed`). Closing a run only on a
 * `closed` relay left it "Running" for good, and the next fire's turn end
 * then closed it with the wrong outcome (KRTX-3007).
 *
 * The match is by session only: a pinned trigger's or a reminder's session
 * carries no trigger metadata, and its runs must close too. Without
 * `sessionId` it settles every open run (the maintenance backstop), and fails
 * runs whose prompt never started a turn within RUN_WITHOUT_TURN_MS.
 */
export async function settleTriggerRunsFromTurns(sessionId?: string, now = new Date()): Promise<number> {
  const failedCreates = await linkQueuedCreateRuns(sessionId);
  if (sessionId) return failedCreates + (await settleSessionRuns(sessionId));
  const t = projectTriggerExecutions;
  const sessions = await db
    .selectDistinct({ sessionId: t.sessionId })
    .from(t)
    .where(and(eq(t.runStatus, 'running'), isNull(t.runEndedAt), isNotNull(t.sessionId)))
    .limit(500);
  let closed = failedCreates;
  for (const row of sessions) closed += await settleSessionRuns(row.sessionId!);
  return closed + (await failRunsWithoutTurns(now));
}

/**
 * A fire queued as a session create (provisioning backpressure, a requeued
 * create) has a `command_id` and no session yet. When the create succeeds,
 * the run takes the session it started, so its turn can close it. When the
 * create dead-letters, no session will ever exist: the run fails with the
 * command's error. Returns the runs failed that way (KRTX-3026).
 */
async function linkQueuedCreateRuns(sessionId?: string): Promise<number> {
  const scope = sessionId ? sql`AND c.session_id = ${sessionId}` : sql``;
  await db.execute(sql`
    UPDATE kortix.project_trigger_executions r
       SET session_id = c.session_id,
           status = CASE WHEN r.status = 'requeued' THEN 'succeeded' ELSE r.status END,
           updated_at = now()
      FROM kortix.session_lifecycle_commands c
     WHERE c.command_id = r.command_id
       AND r.run_status = 'running'
       AND r.session_id IS NULL
       AND c.status = 'succeeded'
       AND c.session_id IS NOT NULL
       ${scope}`);
  if (sessionId) return 0;
  const failed = await db.execute<{ execution_id: string }>(sql`
    UPDATE kortix.project_trigger_executions r
       SET status = CASE WHEN r.status = 'requeued' THEN 'failed' ELSE r.status END,
           run_status = 'failed',
           run_error = coalesce(left(c.last_error, 1000), 'The session was never created.'),
           run_ended_at = c.updated_at,
           updated_at = now()
      FROM kortix.session_lifecycle_commands c
     WHERE c.command_id = r.command_id
       AND r.run_status = 'running'
       AND r.session_id IS NULL
       AND c.status = 'dead_lettered'
    RETURNING r.execution_id`);
  return ((failed as unknown as { rows?: unknown[] }).rows ?? (failed as unknown as unknown[])).length;
}

/**
 * A run open for RUN_WITHOUT_TURN_MS with no turn of its own fails: its
 * prompt was dropped, its session was deleted, or its create never ran.
 * A run whose turn started stays open while that turn runs.
 */
async function failRunsWithoutTurns(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RUN_WITHOUT_TURN_MS).toISOString();
  const failed = await db.execute<{ execution_id: string }>(sql`
    UPDATE kortix.project_trigger_executions r
       SET status = CASE WHEN r.status = 'requeued' THEN 'failed' ELSE r.status END,
           run_status = 'failed',
           run_error = 'No turn ran for this fire.',
           run_ended_at = ${now.toISOString()}::timestamptz,
           updated_at = now()
     WHERE r.run_status = 'running'
       AND r.run_ended_at IS NULL
       AND coalesce(r.claimed_at, r.created_at) < ${cutoff}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM kortix.session_turns st
          WHERE st.session_id = r.session_id
            AND st.started_at >= coalesce(r.claimed_at, r.created_at)
            AND NOT EXISTS (
              SELECT 1 FROM kortix.project_trigger_executions other
               WHERE other.session_id = r.session_id
                 AND other.run_turn_token = st.turn_token))
    RETURNING r.execution_id`);
  return ((failed as unknown as { rows?: unknown[] }).rows ?? (failed as unknown as unknown[])).length;
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
