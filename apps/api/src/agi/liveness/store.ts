/**
 * Every statement the AGI liveness layer issues.
 *
 * It reads the same `agi_tasks` rows the task surface owns and adds nothing to
 * the schema: the durable record of a stalled state is itself a task row, keyed
 * by `origin_fingerprint`, so the R-20 unique index doubles as R-32's
 * "at most one continuation" enforcement. There is no liveness table, no
 * counter, and nothing to keep consistent with the tasks table.
 *
 * Two scoping rules, same as the task store:
 *   • every query filters on `workspace_id`, so a task id from another workspace
 *     is invisible rather than forbidden;
 *   • the server clock decides expiry, never a caller-supplied instant.
 */
import { db } from '../../shared/db';
import { OPEN_TASK_STATUSES, type AgiTaskRow } from '../tasks/wire';
import { STALL_FINGERPRINT_PREFIX } from './wire';
import { accountMembers, agiTasks, projectSessions, projects } from '@kortix/db';
import { and, desc, eq, getTableColumns, gt, inArray, like, sql } from 'drizzle-orm';

const OPEN = [...OPEN_TASK_STATUSES];

/**
 * A task row plus the one fact that CANNOT be recomputed in JavaScript.
 *
 * `updated_at > claimed_at` is R-33's "did anything write this row after the
 * claim". Both columns are `timestamptz`, which Postgres stores to the
 * microsecond, but the driver hands JavaScript a `Date` truncated to the
 * millisecond — so two writes less than a millisecond apart compare EQUAL in JS
 * and a real write reads as "untouched". Evaluating the comparison in SQL keeps
 * the full precision, and it is the difference between a correct determination
 * and one that silently under-reports fast sessions.
 *
 * `false` when the task was never claimed: nothing can have been written since a
 * claim that never happened.
 */
export type AgiTaskWithClaimFacts = AgiTaskRow & { writtenSinceClaim: boolean };

const WRITTEN_SINCE_CLAIM = {
  writtenSinceClaim: sql<boolean>`coalesce(${agiTasks.updatedAt} > ${agiTasks.claimedAt}, false)`,
};

export interface WorkspaceRef {
  projectId: string;
  accountId: string;
  metadata: Record<string, unknown> | null;
}

export async function loadWorkspace(projectId: string): Promise<WorkspaceRef | null> {
  const [row] = await db
    .select({
      projectId: projects.projectId,
      accountId: projects.accountId,
      metadata: projects.metadata,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export interface SessionRef {
  sessionId: string;
  projectId: string;
  accountId: string;
  status: string;
}

export async function loadSession(sessionId: string): Promise<SessionRef | null> {
  const [row] = await db
    .select({
      sessionId: projectSessions.sessionId,
      projectId: projectSessions.projectId,
      accountId: projectSessions.accountId,
      status: projectSessions.status,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Statuses for a set of claim ids, in one round trip.
 *
 * `claim_session_id` carries no foreign key on purpose (see the schema note), so
 * an id that resolves to nothing is normal — it simply stays out of the map and
 * the caller reads it as `unknown`, which never counts as terminal.
 */
export async function loadClaimSessionStatuses(
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({ sessionId: projectSessions.sessionId, status: projectSessions.status })
    .from(projectSessions)
    .where(inArray(projectSessions.sessionId, [...sessionIds]));
  return new Map(rows.map((row) => [row.sessionId, row.status]));
}

/**
 * Open tasks this session still holds a claim on.
 *
 * Workspace-scoped even though `claim_session_id` is effectively unique, because
 * that is what lets `idx_agi_tasks_workspace_open` serve the query — there is no
 * index on `claim_session_id` alone, and the session-finalize hook runs on the
 * request path where a sequential scan would be a real cost.
 *
 * Terminal tasks are excluded because `patchTask` drops the claim in the same
 * statement that lands a terminal status: a done task can never still be here.
 */
export async function loadTasksClaimedBySession(input: {
  workspaceId: string;
  sessionId: string;
}): Promise<AgiTaskWithClaimFacts[]> {
  return db
    .select({ ...getTableColumns(agiTasks), ...WRITTEN_SINCE_CLAIM })
    .from(agiTasks)
    .where(
      and(
        eq(agiTasks.workspaceId, input.workspaceId),
        eq(agiTasks.claimSessionId, input.sessionId),
        inArray(agiTasks.status, OPEN),
      ),
    );
}

/**
 * How many tasks were created underneath `taskId` after the claim landed —
 * R-33's "creating any task", scoped to work this claim can be credited with.
 *
 * Recovery continuations are EXCLUDED, and that exclusion is load-bearing. R-32
 * inserts a continuation with `parent_id` = the stalled task, so from the second
 * sweep onward a task that has done nothing at all has a child created after its
 * claim — and reports `progressed: true` on the strength of an artifact recovery
 * itself produced. The bound still held and escalation still fired, but the
 * evidence was self-referential, and a genuinely dead task would read as alive
 * to anyone scanning `no_progress_count`. A recovery row is bookkeeping about a
 * stall, never work: the same reason {@link resolveWorkspaceLiveness} filters it
 * out of the stall surface.
 */
export async function countChildrenCreatedAfter(input: {
  workspaceId: string;
  taskId: string;
  after: Date;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agiTasks)
    .where(
      and(
        eq(agiTasks.workspaceId, input.workspaceId),
        eq(agiTasks.parentId, input.taskId),
        gt(agiTasks.createdAt, input.after),
        // Prefix match on `origin_fingerprint`, the same complete-and-exact
        // filter `loadRecoveryTasks` uses: nothing but a recovery row ever
        // carries an `agi-stall:v1:` fingerprint. `is null` is kept explicitly
        // because `not like` is NULL for a NULL column, and an ordinary child
        // has no fingerprint at all.
        sql`(${agiTasks.originFingerprint} is null or ${agiTasks.originFingerprint} not like ${`${STALL_FINGERPRINT_PREFIX}:%`})`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Every open task in the workspace, newest first — the input to the stall
 * surface. Bounded rather than paged: "what is stuck" is a whole-workspace
 * question, and a workspace with more open tasks than this has a bigger problem
 * than pagination (R-10 puts goals in the single digits).
 */
export async function loadOpenTasks(
  workspaceId: string,
  limit: number,
): Promise<AgiTaskWithClaimFacts[]> {
  return db
    .select({ ...getTableColumns(agiTasks), ...WRITTEN_SINCE_CLAIM })
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), inArray(agiTasks.status, OPEN)))
    .orderBy(desc(agiTasks.createdAt), desc(agiTasks.taskId))
    .limit(limit);
}

export async function loadTasksByIds(
  workspaceId: string,
  ids: readonly string[],
): Promise<AgiTaskRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), inArray(agiTasks.taskId, [...ids])));
}

/**
 * The recovery rows this workspace has already produced, indexed by fingerprint.
 *
 * The `like` is on the fingerprint PREFIX, which is what keeps this one query
 * instead of one per task: recovery rows are the only ones that ever carry an
 * `agi-stall:v1:` fingerprint, so the prefix is a complete and exact filter.
 */
export async function loadRecoveryTasks(workspaceId: string): Promise<Map<string, AgiTaskRow>> {
  const rows = await db
    .select()
    .from(agiTasks)
    .where(
      and(
        eq(agiTasks.workspaceId, workspaceId),
        like(agiTasks.originFingerprint, `${STALL_FINGERPRINT_PREFIX}:%`),
      ),
    );
  const byFingerprint = new Map<string, AgiTaskRow>();
  for (const row of rows) {
    if (row.originFingerprint) byFingerprint.set(row.originFingerprint, row);
  }
  return byFingerprint;
}

export async function loadRecoveryTask(input: {
  workspaceId: string;
  fingerprint: string;
}): Promise<AgiTaskRow | null> {
  const [row] = await db
    .select()
    .from(agiTasks)
    .where(
      and(
        eq(agiTasks.workspaceId, input.workspaceId),
        eq(agiTasks.originFingerprint, input.fingerprint),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Hand a continuation row to a human (R-32's escalation).
 *
 * The `assignee_user_id is null` predicate makes this idempotent in SQL rather
 * than in the caller: two concurrent sweeps observing the same repeat stall both
 * try, one matches zero rows, and neither can flip an already-escalated row back.
 * Clearing `agent` in the same statement keeps R-14's single-assignee CHECK
 * satisfied.
 *
 * It guards on the assignee and NOT on `agent is not null`, which is the same
 * trick read off the wrong column. A continuation inherits `agent` from its
 * parent, and the canonical create the AGI is told to use — `kortix tasks new
 * ... --goal <slug>` — names no agent, so `agent` is null on every task the AGI
 * actually makes. The old predicate therefore matched zero rows on the FIRST
 * escalation, and the caller reported `escalated` anyway: the one mechanism that
 * pushes a stall at a human silently did nothing for the entire board.
 */
export async function escalateRecoveryTask(input: {
  workspaceId: string;
  taskId: string;
  assigneeUserId: string;
  title: string;
}): Promise<AgiTaskRow | null> {
  const [row] = await db
    .update(agiTasks)
    .set({
      agent: null,
      assigneeUserId: input.assigneeUserId,
      priority: 'urgent',
      title: input.title,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agiTasks.taskId, input.taskId),
        eq(agiTasks.workspaceId, input.workspaceId),
        sql`${agiTasks.assigneeUserId} is null`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Who currently owns an already-escalated continuation. Read only on the
 *  zero-rows path, so the caller can name the real assignee instead of guessing
 *  the account owner — reporting a human who was never assigned is how an
 *  escalation that did nothing reads as one that worked. */
export async function loadRecoveryTaskAssignee(input: {
  workspaceId: string;
  taskId: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ assigneeUserId: agiTasks.assigneeUserId })
    .from(agiTasks)
    .where(and(eq(agiTasks.taskId, input.taskId), eq(agiTasks.workspaceId, input.workspaceId)))
    .limit(1);
  return row?.assigneeUserId ?? null;
}

/** The human R-32 escalates to: the account owner, the same principal
 *  `resolveTriggerActor` already runs unattended work as. */
export async function loadAccountOwner(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * The session-side half of the R-33 writeback.
 *
 * Merged in SQL under the row's own write lock rather than read-modify-written in
 * JS, for the same reason `metadataMerge` exists for projects: a session's
 * metadata has several independent writers and a whole-object write would revert
 * whichever one lost the race.
 */
export async function recordSessionLivenessOutcome(input: {
  sessionId: string;
  outcome: Record<string, unknown>;
}): Promise<void> {
  await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ agi_liveness: input.outcome })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(projectSessions.sessionId, input.sessionId));
}
