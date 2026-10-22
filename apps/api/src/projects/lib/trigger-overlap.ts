/**
 * Trigger overlap (KRTX-1721): a fresh-mode trigger with `overlap: skip` does
 * not start a run while its previous run is still active. `skip` is the default
 * for a cron trigger, `allow` for every other type. A person's fire is never
 * held. The reuse, pinned and keyed modes queue into one session and never run
 * two turns at once, so overlap does not apply to them.
 *
 * "Still active" reads live session state, not `project_trigger_executions`:
 * that table has no reliable end for a run (a turn closed by the reaper, a box
 * stop or a deletion never closes it, and a queued create looks finished).
 * A run is active when a session this trigger created in the last 24 hours is
 * still being set up or its box holds a live turn, or when its create is still
 * queued. The reaper ends every turn within 24 hours, so a lost run holds the
 * trigger for at most that long.
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
export function triggerChecksOverlap(spec: Pick<GitTriggerSpec, 'type' | 'sessionMode' | 'overlap'>): boolean {
  if (spec.sessionMode !== 'fresh') return false;
  return (spec.overlap ?? (spec.type === 'cron' ? 'skip' : 'allow')) === 'skip';
}

/** Why this fire must wait for the trigger's previous run, or null when it may start. */
export async function triggerOverlapReason(input: { projectId: string; slug: string; now: Date }): Promise<string | null> {
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
        gt(projectSessions.createdAt, new Date(input.now.getTime() - ACTIVE_WINDOW_MS)),
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
        sql`${sessionLifecycleCommands.source} LIKE 'trigger:%'`,
        sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_slug' = ${input.slug}`,
        sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_kind' = 'git'`,
      ),
    )
    .limit(1);
  return queued ? `overlap: the previous run is still queued (command ${queued.commandId})` : null;
}
