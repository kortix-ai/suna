/**
 * Goals: everything a goal write does outside its own row — sessions,
 * prompts, the heartbeat reminder, turn aborts. One object, so a DB suite
 * swaps the session and prompt parts for recorders (`setGoalEffectsForTests`)
 * and keeps the real reminder rows.
 */
import { projectSessions, projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { abortRuntimeTurn } from '../session-lifecycle/abort-runtime-turn';
import { createSession, drainSessionLifecycleQueue, enqueueContinueSessionCommand } from '../session-lifecycle';
import type { ProjectRow } from '../lib/serializers';
import {
  deleteSessionReminder,
  disableSessionReminder,
  insertSessionReminderWithinCaps,
  newReminderId,
  reminderSpec,
  setSessionReminderEnabled,
} from '../lib/session-reminders';
import { goalWakePrompt, heartbeatSeconds } from './rules';

/** The source of every prompt the goal engine queues. */
export const GOAL_SOURCE = 'system:goal' as const;
/**
 * The source of the owner and verifier sessions the engine creates. They work
 * for the goal's creator in that person's own folder, so they must be the
 * person's own private sessions (origin `user`): a `system:*` source resolves
 * to origin `system`, and Files then mounts nothing (drives/service.ts
 * `isPersonalSession`). The old SDK created them from the app as the person.
 */
export const GOAL_SESSION_SOURCE = 'ui' as const;

export interface GoalSessionInput {
  project: ProjectRow;
  /** The person the session belongs to (the goal's creator). */
  userId: string;
  sessionId: string;
  agent: string;
  name: string;
  metadata: Record<string, unknown>;
  /** The session this one continues (a successor, a handover). */
  parentSessionId?: string | null;
}

export interface GoalEffects {
  /** Create an idle session (no prompt). Returns its id, or an error line. */
  createSession(input: GoalSessionInput): Promise<{ sessionId: string } | { error: string; status?: number }>;
  /** Queue one prompt into a session. The key dedupes a retry. */
  queuePrompt(input: { project: ProjectRow; sessionId: string; userId: string | null; text: string; key: string }): Promise<boolean>;
  /** Abort the session's running turn, if any. */
  abortTurn(sessionId: string, stoppedBy: string | null): Promise<void>;
}

const liveEffects: GoalEffects = {
  async createSession(input) {
    const result = await createSession({
      source: GOAL_SESSION_SOURCE,
      project: input.project,
      userId: input.userId,
      requestingPrincipalType: 'human',
      body: { session_id: input.sessionId, agent_name: input.agent, name: input.name.slice(0, 120) },
      metadata: input.metadata,
      inSession: false,
      callerSessionId: input.parentSessionId ?? null,
      // No idempotency key: a stored failure would replay on every retry. The
      // fixed session id is the dedupe (setup skips a session that exists).
    });
    if (result.error) return { error: String(result.error.body?.error ?? 'The session could not start'), status: result.error.status };
    return { sessionId: result.row?.sessionId ?? result.sessionId ?? input.sessionId };
  },
  async queuePrompt(input) {
    try {
      await enqueueContinueSessionCommand({
        source: GOAL_SOURCE,
        projectId: input.project.projectId,
        accountId: input.project.accountId,
        sessionId: input.sessionId,
        actorUserId: input.userId,
        text: input.text,
        idempotencyKey: input.key,
      });
      drainSessionLifecycleQueue({ idempotencyKey: input.key, burst: false }).catch(() => {});
      return true;
    } catch (error) {
      logger.warn('[goals] prompt not queued', { session_id: input.sessionId, key: input.key, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  async abortTurn(sessionId, stoppedBy) {
    await abortRuntimeTurn(sessionId, { requestedStop: true, stoppedBy }).catch(() => false);
  },
};

let effects: GoalEffects = liveEffects;
export const goalEffects = (): GoalEffects => effects;
/** Swap the session, prompt and abort effects for a test; null restores the live ones. */
export function setGoalEffectsForTests(next: Partial<GoalEffects> | null): void {
  effects = next ? { ...liveEffects, ...next } : liveEffects;
}

// ── Heartbeat: a session reminder the API alone manages ───────────────────────

export async function createHeartbeat(input: {
  projectId: string;
  sessionId: string;
  agent: string;
  boxFolder: string;
  goalId: string;
  every: string;
  createdBy: string;
  enabled: boolean;
  now: Date;
}): Promise<{ id: string; nextFireAt: Date | null } | { error: string }> {
  const everySeconds = heartbeatSeconds(input.every) ?? 4 * 3600;
  const firstFireAt = new Date(input.now.getTime() + everySeconds * 1000);
  const spec = reminderSpec({
    id: newReminderId(),
    sessionId: input.sessionId,
    agent: input.agent,
    draft: {
      prompt: goalWakePrompt(input.boxFolder, input.goalId),
      name: `goal ${input.boxFolder.split('/').pop() ?? input.goalId}`,
      everySeconds,
      cron: null,
      timezone: 'UTC',
      firstFireAt,
    },
    now: input.now,
    // No author: the heartbeat is the agent's loop, it runs as the session's creator.
    promptAuthorUserId: null,
  });
  const inserted = await insertSessionReminderWithinCaps({
    projectId: input.projectId,
    spec,
    createdBy: input.createdBy,
    firstFireAt,
    now: input.now,
  });
  if ('error' in inserted) return inserted;
  if (!input.enabled) await disableSessionReminder(input.projectId, spec.slug, input.now);
  return { id: spec.slug, nextFireAt: input.enabled ? firstFireAt : null };
}

async function heartbeatRow(projectId: string, id: string) {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, id)))
    .limit(1);
  return row ?? null;
}

/** Turn the heartbeat on (re-armed one period from now) or off. Returns its next fire, or null; false when it does not exist. */
export async function setHeartbeatEnabled(projectId: string, id: string, enabled: boolean, now: Date): Promise<Date | null | false> {
  const row = await heartbeatRow(projectId, id);
  if (!row) return false;
  if (!enabled) {
    if (row.enabled) await disableSessionReminder(projectId, id, now);
    return null;
  }
  if (row.enabled && row.nextFireAt) return row.nextFireAt;
  return (await setSessionReminderEnabled(row, true, now)).nextFireAt;
}

/** Fire the heartbeat once at `at` (a wait's chase, the next UTC day after the cap). */
export async function rescheduleHeartbeat(projectId: string, id: string, at: Date, now: Date): Promise<boolean> {
  const updated = await db
    .update(projectTriggerRuntime)
    .set({ enabled: true, nextFireAt: at, updatedAt: now })
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, id)))
    .returning({ slug: projectTriggerRuntime.slug });
  return updated.length > 0;
}

export async function deleteHeartbeat(projectId: string, id: string): Promise<void> {
  await deleteSessionReminder(projectId, id);
}

/** The heartbeat as it is now, or null when it is gone. */
export async function readHeartbeat(projectId: string, id: string): Promise<{ enabled: boolean; nextFireAt: Date | null; sessionId: string | null } | null> {
  const row = await heartbeatRow(projectId, id);
  return row ? { enabled: row.enabled === true, nextFireAt: row.nextFireAt, sessionId: row.sessionId } : null;
}

/** A session's status for recovery decisions: `missing` when the row is gone or deleted. */
export async function sessionHealth(sessionId: string): Promise<'ok' | 'failed' | 'missing'> {
  const [row] = await db
    .select({ status: projectSessions.status, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return 'missing';
  if (typeof (row.metadata as Record<string, unknown> | null)?.deletedAt === 'string') return 'missing';
  return row.status === 'failed' ? 'failed' : 'ok';
}

export async function sessionExists(sessionId: string): Promise<boolean> {
  const [row] = await db.select({ id: projectSessions.sessionId }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return Boolean(row);
}
