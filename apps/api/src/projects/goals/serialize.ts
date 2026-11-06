/** Goals: row → wire (`@kortix/api-contract` `Goal`, `GoalEvent`, `GoalError`). */
import type { Goal, GoalError as GoalErrorBody, GoalEvent } from '@kortix/api-contract';
import { capabilitiesFor, type GoalActor } from './rules';
import type { GoalError, GoalEventRow, GoalRow } from './store';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function serializeGoal(row: GoalRow, actor: GoalActor): Goal {
  return {
    goal_id: row.goalId,
    project_id: row.projectId,
    revision: row.revision,
    title: row.title,
    state: row.state,
    waiting_on: row.waitingOn,
    chase_at: iso(row.chaseAt),
    summary: row.summary,
    paused_at: iso(row.pausedAt),
    paused_by_user_id: row.pausedByUserId,
    stopped_at: iso(row.stoppedAt),
    blocked_reason: row.blockedReason ?? null,
    assigned_user_id: row.assignedUserId,
    created_by_user_id: row.createdByUserId,
    agent: row.agent,
    space: row.space,
    drive_id: row.driveId,
    folder: row.folder,
    box_folder: row.boxFolder,
    slug: row.slug,
    owner_session_id: row.ownerSessionId,
    sessions: row.sessions,
    criteria_revision: row.criteriaRevision,
    criteria: row.criteria,
    verification: row.verification ?? null,
    heartbeat_every: row.heartbeatEvery,
    next_wake_at: iso(row.nextWakeAt),
    last_wake_at: iso(row.lastWakeAt),
    max_wakes_per_day: row.maxWakesPerDay,
    wakes_today: row.wakesToday,
    max_sessions: row.maxSessions,
    provenance: row.provenance,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    capabilities: capabilitiesFor(row, actor),
  };
}

export function serializeGoalEvent(row: GoalEventRow): GoalEvent {
  return {
    id: row.id,
    goal_id: row.goalId,
    at: row.at.toISOString(),
    kind: row.kind,
    actor_kind: row.actorKind,
    actor_id: row.actorId,
    from_state: (row.fromState as GoalEvent['from_state']) ?? null,
    to_state: (row.toState as GoalEvent['to_state']) ?? null,
    message: row.message,
    data: row.data,
  };
}

export function serializeGoalError(error: GoalError, actor: GoalActor): GoalErrorBody {
  return {
    error: error.code,
    message: error.message,
    ...(error.violations?.length ? { violations: error.violations } : {}),
    ...(error.goal ? { goal: serializeGoal(error.goal, actor) } : {}),
  };
}
