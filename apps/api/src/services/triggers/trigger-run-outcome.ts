import { projectSessions, projectTriggerRuntime } from '@kortix/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { classifyTurnError } from '../../channels/slack/errors';
import { notifySessionEvent } from '../../notifications/session-push';
import { db } from '../../lib/db';
import { resolveProjectAutomationActor } from '../sessions/lifecycle';
import { ABORT_END_ERROR_NAMES, type SandboxTurnCompletionOutcome } from '../sessions/session-turn-ledger';

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
 *   `run_failing_since`. The account owner (whom triggers run as) gets one
 *   push when the streak starts. Later fires keep `failed` (keepRunFailure);
 * - succeeded after failed runs: back to `fired`, error and streak cleared;
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

export async function recordTriggerRunEnd(
  end: TriggerRunEnd,
  notify: typeof notifySessionEvent = notifySessionEvent,
): Promise<TriggerRunEndResult> {
  const slug = triggerSlugOf(end.metadata);
  // Only a turn this call genuinely closed is a run outcome. A replay, a
  // retry, a subagent, or a user's stop says nothing about the trigger.
  if (!slug || end.childSession || end.outcome !== 'closed') return 'not_a_trigger_run';
  if (end.status === 'error' && ABORT_END_ERROR_NAMES.includes(end.error?.name ?? '')) return 'not_a_trigger_run';
  const now = end.now ?? new Date();
  const row = and(eq(projectTriggerRuntime.projectId, end.projectId), eq(projectTriggerRuntime.slug, slug));

  if (end.status === 'idle') {
    const recovered = await db
      .update(projectTriggerRuntime)
      .set({ lastStatus: 'fired', lastError: null, runFailingSince: null, lastAttemptAt: now, updatedAt: now })
      // A failed fire is cleared by the next good fire, not by another fire's run.
      .where(and(row, isNotNull(projectTriggerRuntime.runFailingSince)))
      .returning({ slug: projectTriggerRuntime.slug });
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
  // see it unset, so the owner is pushed once per streak, not once per run.
  const transitioned = await db
    .update(projectTriggerRuntime)
    .set({ lastStatus: 'failed', lastError, runFailingSince: now, lastAttemptAt: now, updatedAt: now })
    .where(and(row, isNull(projectTriggerRuntime.runFailingSince)))
    .returning({ slug: projectTriggerRuntime.slug });
  if (transitioned.length === 0) {
    const refreshed = await db
      .update(projectTriggerRuntime)
      .set({ lastStatus: 'failed', lastError, lastAttemptAt: now, updatedAt: now })
      .where(row)
      .returning({ slug: projectTriggerRuntime.slug });
    return refreshed.length > 0 ? 'still_failed' : 'unchanged';
  }
  // The identity every trigger runs as. `owner_user_id` is deprecated and
  // ignored (integration-trigger-actor.test.ts): it may name a stale human.
  const owner = await resolveProjectAutomationActor(end.accountId);
  if (owner) {
    await notify({ type: 'error', sessionId: end.sessionId, projectId: end.projectId, recipients: [owner] });
  }
  return 'failed';
}
