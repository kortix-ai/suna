/**
 * Every statement the AGI task routes issue.
 *
 * Two invariants are enforced here rather than in the handlers, because they are
 * properties of the SQL and would be lost the moment a caller composed the
 * queries differently:
 *
 *   • Every read and every write filters on `workspace_id` alongside the task id.
 *     A task id belonging to another workspace must be a 404, never a 403 — the
 *     caller is not entitled to learn that the row exists.
 *   • The claim (R-18) and the release are ONE conditional UPDATE each. There is
 *     no read-then-write, no transaction wrapper, and no advisory lock: under
 *     READ COMMITTED the loser of a race re-evaluates the WHERE clause against
 *     the winner's committed row and matches zero rows. That is the whole
 *     mechanism, and adding a read in front of it would break it.
 */
import { db } from '../../shared/db';
import {
  TERMINAL_TASK_STATUSES,
  type AgiTaskRow,
  type AssigneeFilter,
  type ClaimFilter,
  type NullableFilter,
  type StatusFilter,
  type TaskCursor,
  type TaskStatus,
} from './wire';
import { agiTasks } from '@kortix/db/schema';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

const TERMINAL = [...TERMINAL_TASK_STATUSES];

/** Server clock, always. A client-supplied "now" would let a caller declare
 *  another session's live claim expired. */
const NOW = sql`now()`;

export interface TaskListFilters {
  status: StatusFilter;
  goal?: NullableFilter;
  project?: NullableFilter;
  assignee?: AssigneeFilter;
  parent?: NullableFilter;
  blockedBy?: string;
  trigger?: string;
  claim?: ClaimFilter;
  cursor?: TaskCursor;
  limit: number;
}

function assigneeCondition(filter: AssigneeFilter): SQL {
  switch (filter.kind) {
    case 'agent':
      return eq(agiTasks.agent, filter.agent);
    case 'user':
      return eq(agiTasks.assigneeUserId, filter.userId);
    case 'none':
      return and(isNull(agiTasks.agent), isNull(agiTasks.assigneeUserId)) as SQL;
    case 'any':
      return or(isNotNull(agiTasks.agent), isNotNull(agiTasks.assigneeUserId)) as SQL;
  }
}

/** Free = unclaimed or expired; held is its exact negation, so every open task
 *  falls in exactly one bucket (the coherence CHECK is what makes this total). */
function claimCondition(filter: ClaimFilter): SQL {
  const free = or(isNull(agiTasks.claimSessionId), lt(agiTasks.claimExpiresAt, NOW)) as SQL;
  return filter === 'free'
    ? free
    : (and(isNotNull(agiTasks.claimSessionId), sql`${agiTasks.claimExpiresAt} >= now()`) as SQL);
}

export async function listTasks(
  workspaceId: string,
  filters: TaskListFilters,
): Promise<AgiTaskRow[]> {
  const conditions: SQL[] = [eq(agiTasks.workspaceId, workspaceId)];

  if (filters.status.kind === 'in') {
    // An empty status set can only come from a filter that matches nothing;
    // inArray with [] is invalid SQL in some dialects, so short-circuit it.
    if (filters.status.statuses.length === 0) return [];
    conditions.push(inArray(agiTasks.status, filters.status.statuses));
  }
  if (filters.goal) {
    conditions.push(
      filters.goal.kind === 'none' ? isNull(agiTasks.goalSlug) : eq(agiTasks.goalSlug, filters.goal.value),
    );
  }
  if (filters.project) {
    conditions.push(
      filters.project.kind === 'none'
        ? isNull(agiTasks.project)
        : eq(agiTasks.project, filters.project.value),
    );
  }
  if (filters.assignee) conditions.push(assigneeCondition(filters.assignee));
  if (filters.parent) {
    conditions.push(
      filters.parent.kind === 'none'
        ? isNull(agiTasks.parentId)
        : eq(agiTasks.parentId, filters.parent.value),
    );
  }
  // Array containment, which only the GIN index can serve — "what does X block?"
  if (filters.blockedBy) {
    conditions.push(sql`${agiTasks.blockedBy} @> array[${filters.blockedBy}::uuid]`);
  }
  if (filters.trigger) conditions.push(eq(agiTasks.triggerSlug, filters.trigger));
  if (filters.claim) conditions.push(claimCondition(filters.claim));
  if (filters.cursor) {
    conditions.push(
      sql`(${agiTasks.createdAt}, ${agiTasks.taskId}) < (${filters.cursor.createdAt}::timestamptz, ${filters.cursor.taskId}::uuid)`,
    );
  }

  return db
    .select()
    .from(agiTasks)
    .where(and(...conditions))
    .orderBy(desc(agiTasks.createdAt), desc(agiTasks.taskId))
    .limit(filters.limit);
}

export async function loadTask(workspaceId: string, taskId: string): Promise<AgiTaskRow | null> {
  const [row] = await db
    .select()
    .from(agiTasks)
    .where(and(eq(agiTasks.taskId, taskId), eq(agiTasks.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function loadChildren(
  workspaceId: string,
  parentId: string,
  limit: number,
): Promise<AgiTaskRow[]> {
  return db
    .select()
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), eq(agiTasks.parentId, parentId)))
    .orderBy(desc(agiTasks.createdAt), desc(agiTasks.taskId))
    .limit(limit);
}

export async function loadTasksByIds(
  workspaceId: string,
  ids: readonly string[],
  limit: number,
): Promise<AgiTaskRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), inArray(agiTasks.taskId, [...ids])))
    .limit(limit);
}

/** Which of `ids` actually exist in this workspace. Used to turn an unknown
 *  parent/blocker into a 400 with a specific code instead of a dangling edge. */
export async function resolveTaskIds(
  workspaceId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ taskId: agiTasks.taskId })
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), inArray(agiTasks.taskId, [...ids])));
  return new Set(rows.map((row) => row.taskId));
}

/**
 * Would re-parenting `taskId` under `parentId` close a loop? Walks the
 * candidate's ancestors in one recursive CTE. The self-referencing FK is
 * ON DELETE SET NULL, so a cycle can only ever be introduced by a PATCH — this
 * is the only place that has to defend the rollup walk's termination beyond the
 * parent-not-self CHECK.
 */
export async function wouldCreateParentCycle(
  workspaceId: string,
  taskId: string,
  parentId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    with recursive ancestors as (
      select task_id, parent_id
        from kortix.agi_tasks
       where task_id = ${parentId}::uuid and workspace_id = ${workspaceId}::uuid
      union all
      select t.task_id, t.parent_id
        from kortix.agi_tasks t
        join ancestors a on t.task_id = a.parent_id
       where t.workspace_id = ${workspaceId}::uuid
    )
    select 1 from ancestors where task_id = ${taskId}::uuid limit 1
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return rows.length > 0;
}

export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  body: string | null;
  goalSlug: string | null;
  project: string | null;
  parentId: string | null;
  status: TaskStatus;
  priority: string;
  agent: string | null;
  assigneeUserId: string | null;
  blockedBy: string[];
  triggerSlug: string | null;
  origin: string;
  originFingerprint: string | null;
}

/**
 * R-20. One statement: the unique index does the deduplication, so two triggers
 * firing for the same logical event race into the same row instead of racing to
 * check-then-insert. `created:false` means the fingerprint already existed —
 * when it is null the partial index cannot fire and two creates always yield
 * two rows, which is what an unfingerprinted `kortix tasks new` should do.
 */
export async function createTask(
  input: CreateTaskInput,
): Promise<{ row: AgiTaskRow; created: boolean }> {
  const [inserted] = await db
    .insert(agiTasks)
    .values({
      workspaceId: input.workspaceId,
      title: input.title,
      body: input.body,
      goalSlug: input.goalSlug,
      project: input.project,
      parentId: input.parentId,
      status: input.status,
      priority: input.priority,
      agent: input.agent,
      assigneeUserId: input.assigneeUserId,
      blockedBy: input.blockedBy,
      triggerSlug: input.triggerSlug,
      origin: input.origin,
      originFingerprint: input.originFingerprint,
    })
    // `where` here is the index PREDICATE, not a row filter — drizzle emits it
    // directly after the conflict target, which is what a partial unique index
    // requires for inference.
    .onConflictDoNothing({
      target: [agiTasks.workspaceId, agiTasks.originFingerprint],
      where: sql`origin_fingerprint is not null`,
    })
    .returning();

  if (inserted) return { row: inserted, created: true };

  // Only reachable with a non-null fingerprint: the partial index excludes null
  // rows, so an unfingerprinted insert can never conflict and always returns.
  const [existing] = await db
    .select()
    .from(agiTasks)
    .where(
      and(
        eq(agiTasks.workspaceId, input.workspaceId),
        eq(agiTasks.originFingerprint, input.originFingerprint ?? ''),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('agi task insert conflicted but the conflicting row is gone');
  return { row: existing, created: false };
}

/** The columns a PATCH may set, already translated to drizzle field names. */
export type TaskPatch = Partial<{
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: string;
  goalSlug: string | null;
  project: string | null;
  parentId: string | null;
  agent: string | null;
  assigneeUserId: string | null;
  blockedBy: string[];
  triggerSlug: string | null;
}>;

export async function patchTask(
  workspaceId: string,
  taskId: string,
  patch: TaskPatch,
): Promise<AgiTaskRow | null> {
  // The one normative side effect: reaching a terminal status drops the claim in
  // the SAME statement, so a done task can never be left holding a lease that a
  // later adopter would have to wait out.
  const clearsClaim = patch.status !== undefined && (patch.status === 'done' || patch.status === 'cancelled');

  const [row] = await db
    .update(agiTasks)
    .set({
      ...patch,
      ...(clearsClaim ? { claimSessionId: null, claimedAt: null, claimExpiresAt: null } : {}),
      updatedAt: NOW,
    })
    .where(and(eq(agiTasks.taskId, taskId), eq(agiTasks.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/**
 * R-18 / R-19, in one statement.
 *
 * The third disjunct — `claim_session_id = $session` — makes a re-claim by the
 * SAME session an idempotent lease EXTENSION rather than a conflict. That is
 * required, not a convenience: it is what lets a live session heartbeat its
 * claim so it can never be broken, while a crashed session's claim becomes
 * adoptable the moment `claim_expires_at` passes.
 */
export async function claimTask(input: {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  ttlSeconds: number;
  status?: TaskStatus;
}): Promise<AgiTaskRow | null> {
  const [row] = await db
    .update(agiTasks)
    .set({
      claimSessionId: input.sessionId,
      claimedAt: NOW,
      claimExpiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds}::int)`,
      ...(input.status ? { status: input.status } : {}),
      updatedAt: NOW,
    })
    .where(
      and(
        eq(agiTasks.taskId, input.taskId),
        eq(agiTasks.workspaceId, input.workspaceId),
        notInArray(agiTasks.status, TERMINAL),
        or(
          isNull(agiTasks.claimSessionId),
          lt(agiTasks.claimExpiresAt, NOW),
          eq(agiTasks.claimSessionId, input.sessionId),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Only the CURRENT holder can release. There is deliberately no force-release
 *  and no admin override: R-19 forbids breaking a live session's claim, so a
 *  stuck claim is resolved by expiry and the TTL is the only lever. */
export async function releaseTask(input: {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  status?: TaskStatus;
}): Promise<AgiTaskRow | null> {
  const [row] = await db
    .update(agiTasks)
    .set({
      claimSessionId: null,
      claimedAt: null,
      claimExpiresAt: null,
      ...(input.status ? { status: input.status } : {}),
      updatedAt: NOW,
    })
    .where(
      and(
        eq(agiTasks.taskId, input.taskId),
        eq(agiTasks.workspaceId, input.workspaceId),
        eq(agiTasks.claimSessionId, input.sessionId),
      ),
    )
    .returning();
  return row ?? null;
}
