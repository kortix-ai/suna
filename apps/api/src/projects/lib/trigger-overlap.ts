/**
 * Trigger overlap (KRTX-1721): a trigger with `overlap: skip` does not start a
 * run while its previous run is still active. `skip` is the default for a cron
 * trigger, `allow` for every other type. A person's fire is never held.
 *
 * The reuse, pinned and keyed modes queue into one session and never run two
 * turns at once. For them "still active" means the previous fire's prompt is
 * still waiting in the queue: a run longer than the schedule otherwise stacks
 * one prompt per fire, without bound (prod 2026-11-03: 49 cron prompts queued
 * in one session over a day, each re-polled every 2 s). A keyed fire checks
 * only the session of its own key; a key that renders empty starts a fresh
 * session and is never held.
 *
 * "Still active" reads live session state, not `project_trigger_executions`:
 * that table has no reliable end for a run (a turn closed by the reaper, a box
 * stop or a deletion never closes it, and a queued create looks finished).
 * A run is active when a session this trigger created in the last 24 hours is
 * still being set up or its box holds a live turn, or when a create or prompt
 * it enqueued in the last 24 hours is still queued or running. The reaper ends
 * every turn within 24 hours, so a lost run holds the trigger for at most that
 * long. The window bounds the command rows too: a `running` row that no worker
 * will ever settle held its trigger for good (prod 2026-11-03: create commands
 * stuck since July and September skipped 9 cron triggers on every fire).
 */
import { projectSessions, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { sessionHoldsTurnAuthority } from '../session-lifecycle/inbox-admission';
import type { GitTriggerSpec } from '../triggers';
import { PROVISIONING_SESSION_STATUSES } from './session-status';

export const TRIGGER_OVERLAP_MODES = ['skip', 'allow'] as const;
export type TriggerOverlapMode = (typeof TRIGGER_OVERLAP_MODES)[number];

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_SESSIONS = 20;

/** Whether a fire of this trigger checks for a run still in progress. */
export function triggerChecksOverlap(spec: Pick<GitTriggerSpec, 'type' | 'overlap'>): boolean {
  return (spec.overlap ?? (spec.type === 'cron' ? 'skip' : 'allow')) === 'skip';
}

/** Why this fire must wait for the trigger's previous run, or null when it may start. */
export async function triggerOverlapReason(input: {
  projectId: string;
  slug: string;
  now: Date;
  sessionMode?: GitTriggerSpec['sessionMode'];
  /** The rendered key of a keyed fire; null when it rendered empty. */
  sessionKey?: string | null;
}): Promise<string | null> {
  const { projectId, slug } = input;
  const since = new Date(input.now.getTime() - ACTIVE_WINDOW_MS);
  if (input.sessionMode === 'reuse' || input.sessionMode === 'pinned') return waitingPromptReason({ projectId, slug, since });
  if (input.sessionMode === 'keyed') {
    return input.sessionKey ? waitingPromptReason({ projectId, slug, since, sessionKey: input.sessionKey }) : null;
  }
  const recent = await db
    .select({
      sessionId: projectSessions.sessionId,
      status: projectSessions.status,
      boxStatus: sessionSandboxes.status,
      boxMetadata: sessionSandboxes.metadata,
    })
    .from(projectSessions)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, projectSessions.sessionId))
    .where(
      and(
        eq(projectSessions.projectId, input.projectId),
        ne(projectSessions.status, 'failed'),
        gt(projectSessions.createdAt, since),
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${input.slug}`,
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
        sql`${projectSessions.metadata} ->> 'deletedAt' IS NULL`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(RECENT_SESSIONS);
  const active = recent.find(
    (row) =>
      (PROVISIONING_SESSION_STATUSES as readonly string[]).includes(row.status) ||
      sessionHoldsTurnAuthority(row.boxStatus ? { status: row.boxStatus, metadata: row.boxMetadata } : null),
  );
  if (active) return `overlap: the previous run is still active (session ${active.sessionId})`;

  const [queued] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.projectId, input.projectId),
        eq(sessionLifecycleCommands.commandType, 'create_session'),
        inArray(sessionLifecycleCommands.status, ['queued', 'running']),
        gt(sessionLifecycleCommands.createdAt, since),
        sql`${sessionLifecycleCommands.source} LIKE 'trigger:%'`,
        sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_slug' = ${input.slug}`,
        sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_kind' = 'git'`,
      ),
    )
    .limit(1);
  return queued ? `overlap: the previous run is still queued (command ${queued.commandId})` : null;
}

/**
 * A reuse, pinned or keyed trigger's previous prompt that is still waiting to
 * be delivered. A keyed fire looks only in the sessions of its own key.
 */
async function waitingPromptReason(input: {
  projectId: string;
  slug: string;
  since: Date;
  sessionKey?: string;
}): Promise<string | null> {
  const [waiting] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.projectId, input.projectId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        inArray(sessionLifecycleCommands.status, ['queued', 'running']),
        gt(sessionLifecycleCommands.createdAt, input.since),
        sql`${sessionLifecycleCommands.source} LIKE 'trigger:%'`,
        sql`${sessionLifecycleCommands.payload} ->> 'triggerSlug' = ${input.slug}`,
        input.sessionKey === undefined
          ? undefined
          : inArray(
              sessionLifecycleCommands.sessionId,
              db
                .select({ sessionId: projectSessions.sessionId })
                .from(projectSessions)
                .where(
                  and(
                    eq(projectSessions.projectId, input.projectId),
                    sql`${projectSessions.metadata} ->> 'trigger_slug' = ${input.slug}`,
                    sql`${projectSessions.metadata} ->> 'trigger_session_key' = ${input.sessionKey}`,
                  ),
                ),
            ),
      ),
    )
    .limit(1);
  return waiting ? `overlap: the previous prompt is still waiting (command ${waiting.commandId})` : null;
}
