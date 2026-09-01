/**
 * Subproject runs — the read side of "what has this subproject actually done".
 *
 * A run is one row in `project_trigger_executions`: the durable slot the cron
 * sweep materializes, claims, and dispatches. That table already records
 * `scheduled_for`, `attempts`, `last_error`, `dispatched_at`, `completed_at` and
 * a `session_id` FK — everything a run report needs — and had ZERO API routes
 * before this. Nothing new is written for subproject runs; the join is what was
 * missing.
 *
 * The join is `project_trigger_runtime.subproject_slug`, materialized from each
 * trigger's manifest `subproject:` field. That is why it is indexed
 * (`idx_project_trigger_runtime_subproject`, partial on `subproject_slug IS NOT NULL`):
 * one lookup finds the subproject's trigger slugs, and the executions come back on
 * the composite `(project_id, slug)`.
 *
 * Outcome derivation lives in `./subproject-run-status.ts` — a leaf, because the
 * "why there is no stored success flag" reasoning is worth testing on its own.
 */

import {
  projectSessions,
  projectTriggerExecutions,
  projectTriggerRuntime,
  sessionTurns,
} from '@kortix/db';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  type SubprojectRunStats,
  type SubprojectRunStatus,
  subprojectRunStats,
  subprojectRunStatus,
} from './subproject-run-status';

/** One run, as the report renders it. */
export interface SubprojectRunRecord {
  execution_id: string;
  /** The subproject this run belongs to. Present on the all-subprojects listing. */
  subproject_slug: string;
  /** The trigger that fired. */
  trigger_slug: string;
  status: SubprojectRunStatus;
  /** The dispatch status underneath, for a report that wants to be precise. */
  execution_status: string;
  /** When the slot was due — the schedule's promise. */
  scheduled_for: string;
  /** When dispatch actually began. Null while still queued. */
  dispatched_at: string | null;
  completed_at: string | null;
  created_at: string;
  attempts: number;
  last_error: string | null;
  /** The session this run produced, or null. The run circle links to it. */
  session_id: string | null;
  session_status: string | null;
  /** The session's generated title — the closest thing to "what it delivered". */
  summary: string | null;
  /** Wall-clock length in ms, or null while the run is still open. */
  duration_ms: number | null;
}

export interface ListSubprojectRunsInput {
  projectId: string;
  /** One subproject, or every subproject in the project when omitted. */
  subprojectSlug?: string | null;
  limit: number;
  offset: number;
}

/** The newest ended turn per session — the outcome signal, read in ONE query. */
async function lastEndedTurnBySession(
  sessionIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (sessionIds.length === 0) return new Map();
  // DISTINCT ON keyed by session, newest ended turn first. One statement for
  // the whole page: `readSessionTurnState` is per-session (two queries each),
  // which on a 50-run page would be 100 round trips for a list view.
  const rows = await db
    .selectDistinctOn([sessionTurns.sessionId], {
      sessionId: sessionTurns.sessionId,
      endReason: sessionTurns.endReason,
    })
    .from(sessionTurns)
    .where(and(inArray(sessionTurns.sessionId, [...sessionIds]), eq(sessionTurns.state, 'ended')))
    .orderBy(sessionTurns.sessionId, desc(sessionTurns.endedAt), desc(sessionTurns.startedAt));
  return new Map(rows.map((row) => [row.sessionId, row.endReason]));
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Wall-clock length of one run.
 *
 * `completed_at - dispatched_at` is the dispatch window, which is what the
 * executions table can speak to. It is deliberately NOT derived from the
 * session's turn timestamps: a `session_mode: reuse` trigger accumulates many
 * turns in one session, and attributing the whole session's span to one run
 * would over-report every run after the first.
 */
function durationMs(dispatchedAt: Date | null, completedAt: Date | null): number | null {
  if (!dispatchedAt || !completedAt) return null;
  const ms = completedAt.getTime() - dispatchedAt.getTime();
  return ms >= 0 ? ms : null;
}

/**
 * List a project's subproject runs, newest first.
 *
 * Scoped to triggers whose `subproject_slug` is set, so a hand-authored trigger's
 * executions never appear in a subproject report — and, with `subprojectSlug` given, to
 * that one subproject.
 */
export async function listSubprojectRuns(
  input: ListSubprojectRunsInput,
): Promise<{ runs: SubprojectRunRecord[]; total: number }> {
  const scope = input.subprojectSlug
    ? and(
        eq(projectTriggerExecutions.projectId, input.projectId),
        eq(projectTriggerRuntime.subprojectSlug, input.subprojectSlug),
      )
    : and(
        eq(projectTriggerExecutions.projectId, input.projectId),
        isNotNull(projectTriggerRuntime.subprojectSlug),
      );

  const [rows, counted] = await Promise.all([
    db
      .select({
        executionId: projectTriggerExecutions.executionId,
        subprojectSlug: projectTriggerRuntime.subprojectSlug,
        triggerSlug: projectTriggerExecutions.slug,
        executionStatus: projectTriggerExecutions.status,
        scheduledFor: projectTriggerExecutions.scheduledFor,
        dispatchedAt: projectTriggerExecutions.dispatchedAt,
        completedAt: projectTriggerExecutions.completedAt,
        createdAt: projectTriggerExecutions.createdAt,
        attempts: projectTriggerExecutions.attempts,
        lastError: projectTriggerExecutions.lastError,
        sessionId: projectTriggerExecutions.sessionId,
        sessionStatus: projectSessions.status,
        sessionMetadata: projectSessions.metadata,
      })
      .from(projectTriggerExecutions)
      // INNER join: an execution whose trigger has no runtime row cannot be
      // attributed to a subproject, so it is not a subproject run.
      .innerJoin(
        projectTriggerRuntime,
        and(
          eq(projectTriggerRuntime.projectId, projectTriggerExecutions.projectId),
          eq(projectTriggerRuntime.slug, projectTriggerExecutions.slug),
        ),
      )
      // LEFT: the session FK is ON DELETE SET NULL, and a queued slot has none
      // yet. Either way the run still happened and must still be listed.
      .leftJoin(projectSessions, eq(projectSessions.sessionId, projectTriggerExecutions.sessionId))
      .where(scope)
      .orderBy(desc(projectTriggerExecutions.createdAt))
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(projectTriggerExecutions)
      .innerJoin(
        projectTriggerRuntime,
        and(
          eq(projectTriggerRuntime.projectId, projectTriggerExecutions.projectId),
          eq(projectTriggerRuntime.slug, projectTriggerExecutions.slug),
        ),
      )
      .where(scope),
  ]);

  const turnBySession = await lastEndedTurnBySession(
    rows.map((r) => r.sessionId).filter((id): id is string => !!id),
  );

  const runs: SubprojectRunRecord[] = rows.map((row) => {
    const metadata = (row.sessionMetadata ?? {}) as Record<string, unknown>;
    const lastTurnEndReason = row.sessionId ? (turnBySession.get(row.sessionId) ?? null) : null;
    return {
      execution_id: row.executionId,
      subproject_slug: row.subprojectSlug ?? '',
      trigger_slug: row.triggerSlug,
      status: subprojectRunStatus({
        executionStatus: row.executionStatus,
        attempts: row.attempts,
        lastError: row.lastError,
        sessionStatus: row.sessionStatus ?? null,
        lastTurnEndReason,
      }),
      execution_status: row.executionStatus,
      scheduled_for: row.scheduledFor.toISOString(),
      dispatched_at: isoOrNull(row.dispatchedAt),
      completed_at: isoOrNull(row.completedAt),
      created_at: row.createdAt.toISOString(),
      attempts: row.attempts,
      last_error: row.lastError,
      session_id: row.sessionId,
      session_status: row.sessionStatus ?? null,
      // The session's generated title is the honest stand-in for "what this run
      // delivered" — real data the titling hook already produces, rather than a
      // summary nothing writes.
      summary:
        typeof metadata.custom_name === 'string' && metadata.custom_name.trim()
          ? metadata.custom_name.trim()
          : typeof metadata.name === 'string' && metadata.name.trim()
            ? metadata.name.trim()
            : null,
      duration_ms: durationMs(row.dispatchedAt, row.completedAt),
    };
  });

  return { runs, total: counted[0]?.n ?? 0 };
}

/** Aggregate stats for one subproject, computed over the runs handed in. */
export function summarizeSubprojectRuns(runs: readonly SubprojectRunRecord[]): SubprojectRunStats {
  return subprojectRunStats(runs.map((r) => ({ status: r.status, durationMs: r.duration_ms })));
}
