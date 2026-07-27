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
  OPEN_TASK_STATUSES,
  TASK_PRIORITIES,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  type AgiTaskRow,
  type AssigneeFilter,
  type ClaimFilter,
  type NullableFilter,
  type StatusFilter,
  type TaskCursor,
  type TaskPriority,
  type TaskStatus,
} from './wire';
import { agiTasks } from '@kortix/db';
import {
  and,
  asc,
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
  type SQLWrapper,
} from 'drizzle-orm';

/**
 * Everything this module derives from `./wire` or from the Drizzle table is built
 * ON FIRST USE, never at import time, because this file sits on a genuine runtime
 * import cycle:
 *
 *   agi/tasks/wire.ts
 *     -> projects/lib/serializers.ts   (wire imports UUID_V4_REGEX from it)
 *     -> projects/lib/sessions.ts
 *     -> agi/liveness/index.ts
 *     -> agi/liveness/session-outcome.ts
 *     -> agi/tasks/store.ts            (back here)
 *
 * When the process happens to enter that ring at `wire.ts`, store.ts's module
 * body runs while wire.ts is still mid-evaluation, so its `const` exports are in
 * the temporal dead zone and any import-time dereference throws
 * "Cannot access 'TERMINAL_TASK_STATUSES' before initialization". Which module
 * the ring is entered at depends purely on load order, so this is invisible when
 * a suite runs alone and fires when several files are loaded in one process —
 * `bun test src/agi/` reproduced it, ten unhandled errors, while every one of
 * those files passed on its own.
 *
 * Deferring the dereference to call time removes the dependency on load order
 * entirely: by the time any exported query function runs, every module in the
 * ring has finished evaluating. Memoized because these values are immutable and
 * are read on every list/claim.
 */
function once<T>(build: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value as T;
  };
}

const terminalStatuses = once(() => [...TERMINAL_TASK_STATUSES]);
const openStatuses = once(() => [...OPEN_TASK_STATUSES]);

/** Server clock, always. A client-supplied "now" would let a caller declare
 *  another session's live claim expired. */
const NOW = sql`now()`;

export interface TaskListFilters {
  status: StatusFilter;
  priorities?: TaskPriority[];
  /** The work-finding view: open, every blocker completed, claim free. */
  ready?: boolean;
  /** Open and untouched for at least this many days — the stalled-task signal. */
  idleDays?: number;
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

/**
 * Queue rank for a priority value. TASK_PRIORITIES is declared most- to
 * least-urgent, so the array index IS the rank and the two can never drift.
 * Anything the CHECK constraint does not know sorts LAST: an unrecognized
 * priority must not be able to jump the queue.
 *
 * Takes the column rather than closing over `agi_tasks.priority` because the
 * cursor comparison needs the same expression over a DIFFERENT alias, where an
 * unqualified reference would silently resolve to the outer row.
 */
function priorityRank(column: SQLWrapper): SQL {
  const branches = TASK_PRIORITIES.map(
    (priority, index) => sql`when ${priority} then ${sql.raw(String(index))}`,
  );
  const last = sql.raw(String(TASK_PRIORITIES.length));
  return sql`(case ${column} ${sql.join(branches, sql` `)} else ${last} end)`;
}

/** Lazy for the same reason as {@link terminalStatuses}: `priorityRank` reads
 *  TASK_PRIORITIES out of `./wire`. */
const queueRank = once(() => priorityRank(agiTasks.priority));

/**
 * Two orderings, chosen by what the caller asked for rather than by a parameter.
 *
 *   queue   — priority first, then OLDEST first. A task nobody has finished must
 *             RISE toward page 1 as it ages, never sink under whatever was
 *             invented this morning. This is the ordering the loop reads.
 *   history — newest first, the natural reading order for a listing that can
 *             only contain finished work.
 */
type ListOrder = 'queue' | 'history';

function listOrder(status: StatusFilter): ListOrder {
  const terminalOnly =
    status.kind === 'in' &&
    status.statuses.length > 0 &&
    status.statuses.every((s) => isTerminalTaskStatus(s));
  return terminalOnly ? 'history' : 'queue';
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

/**
 * R-17, the query half: every blocker id is contained in the set of this task's
 * blockers that genuinely COMPLETED.
 *
 * Only `done` counts. A CANCELLED blocker does not satisfy the dependency, and
 * neither does an id that no longer resolves — both leave the task unready,
 * which is the whole point of R-17 and the trap this predicate exists to avoid.
 * An empty `blocked_by` is contained by the empty set, so an unblocked task is
 * ready by construction.
 *
 * This is authoritative on its own: `resolveCompletedBlocker` prunes satisfied
 * edges as bookkeeping, but readiness never depends on that prune having run.
 */
const blockersSatisfied = once(
  () => sql`${agiTasks.blockedBy} <@ coalesce((
    select array_agg(resolved.task_id)
      from kortix.agi_tasks resolved
     where resolved.workspace_id = ${agiTasks.workspaceId}
       and resolved.task_id = any(${agiTasks.blockedBy})
       and resolved.status = 'done'
  ), '{}'::uuid[])`,
);

/** The `--ready` view, as three ANDed predicates rather than a mode: composed
 *  with a caller's own filters it narrows, and can never widen them. */
function readyConditions(): SQL[] {
  return [inArray(agiTasks.status, openStatuses()), claimCondition('free'), blockersSatisfied()];
}

/**
 * One component of the keyset comparison value, read back from the cursor ROW.
 *
 * The token is `created_at|task_id`, which is enough to IDENTIFY the row but not
 * to compare against it: it carries no priority at all, and `toISOString()`
 * truncates the timestamp to milliseconds while Postgres stores microseconds.
 * Comparing against the truncated value duplicates rows in an ascending keyset
 * and, worse, silently SKIPS them in a descending one. So the token names the
 * row and the row supplies its own exact sort key — still one indexed lookup,
 * one row comparison, and no OFFSET.
 *
 * `fallback` covers a cursor whose row is gone. Both fallbacks are chosen to
 * re-emit already-seen rows rather than skip unseen ones: for a work queue,
 * duplicates are recoverable and omissions are not. (No route deletes a task;
 * cancelling is a status.)
 */
function cursorField(
  workspaceId: string,
  cursor: TaskCursor,
  select: SQL,
  fallback: SQL,
): SQL {
  return sql`coalesce((
      select ${select}
        from kortix.agi_tasks cursor_row
       where cursor_row.task_id = ${cursor.taskId}::uuid
         and cursor_row.workspace_id = ${workspaceId}::uuid
    ), ${fallback})`;
}

/**
 * Keyset continuation, in the same shape as the ORDER BY it accompanies.
 * History pages on (created_at, task_id); the queue pages on the FULL sort key,
 * because a two-column keyset under a three-column ordering skips rows.
 */
function cursorCondition(workspaceId: string, cursor: TaskCursor, order: ListOrder): SQL {
  const createdAt = cursorField(
    workspaceId,
    cursor,
    sql`cursor_row.created_at`,
    sql`${cursor.createdAt}::timestamptz`,
  );
  if (order === 'history') {
    return sql`(${agiTasks.createdAt}, ${agiTasks.taskId}) < (${createdAt}, ${cursor.taskId}::uuid)`;
  }
  // Rank 0 is the most urgent band: an unresolvable cursor restarts at the top
  // of the queue from that timestamp rather than skipping every band above it.
  const rank = cursorField(
    workspaceId,
    cursor,
    priorityRank(sql`cursor_row.priority`),
    sql`0`,
  );
  return sql`(${queueRank()}, ${agiTasks.createdAt}, ${agiTasks.taskId}) > (${rank}, ${createdAt}, ${cursor.taskId}::uuid)`;
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
  if (filters.priorities) {
    if (filters.priorities.length === 0) return [];
    conditions.push(inArray(agiTasks.priority, filters.priorities));
  }
  if (filters.ready) conditions.push(...readyConditions());
  // Idle is measured from updated_at: the last time ANYTHING about the task
  // changed. A row that has not moved in a week has no answer to R-28's "what
  // moves this forward next?" and must be visible rather than paged away.
  if (filters.idleDays !== undefined) {
    conditions.push(sql`${agiTasks.updatedAt} < now() - make_interval(days => ${filters.idleDays}::int)`);
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

  const order = listOrder(filters.status);
  if (filters.cursor) conditions.push(cursorCondition(workspaceId, filters.cursor, order));

  const query = db
    .select()
    .from(agiTasks)
    .where(and(...conditions));

  return order === 'history'
    ? query.orderBy(desc(agiTasks.createdAt), desc(agiTasks.taskId)).limit(filters.limit)
    : query
        .orderBy(sql`${queueRank()} asc`, asc(agiTasks.createdAt), asc(agiTasks.taskId))
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

/**
 * R-17, the resolving half. A blocker that genuinely COMPLETED satisfies the
 * dependency, so its edge is dropped from every task that was waiting on it —
 * otherwise a finished blocker leaves the edge forever and every daily push has
 * to hand-resolve it.
 *
 * A CANCELLED blocker is deliberately NOT pruned. "The work happened" and "the
 * work will never happen" are different answers, and only the first one releases
 * whatever was waiting; R-17 says that edge stays unresolved until a human
 * removes or replaces it. That is why this is keyed on `done` alone and why no
 * caller may pass the status in.
 *
 * Dropping the last edge also moves `blocked` → `todo`, the same rule
 * `kortix tasks block` applies when it removes an edge: a task with an empty
 * `blocked_by` still sitting in `blocked` is a lie about why it is not moving.
 *
 * One-way: re-opening a completed blocker does not restore the edges it
 * released. Whoever re-opens it is re-stating the dependency, not undoing a
 * bookkeeping step.
 */
export async function resolveCompletedBlocker(
  workspaceId: string,
  blockerId: string,
): Promise<number> {
  // `blocked_by` on the right-hand side is the pre-update value, so the CASE and
  // the assignment see the same array — one statement, no read-then-write.
  const result = await db.execute(sql`
    update kortix.agi_tasks
       set blocked_by = array_remove(blocked_by, ${blockerId}::uuid),
           status = case
                      when status = 'blocked'
                       and array_remove(blocked_by, ${blockerId}::uuid) = '{}'::uuid[]
                      then 'todo'
                      else status
                    end,
           updated_at = now()
     where workspace_id = ${workspaceId}::uuid
       and blocked_by @> array[${blockerId}::uuid]
    returning task_id
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return rows.length;
}

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
  if (!row) return null;
  await pruneEdgesIfCompleted(workspaceId, row);
  return row;
}

/** Runs off the WRITTEN row rather than the patch, so it also heals edges left
 *  behind by an already-done task — the prune is idempotent and readiness never
 *  depended on it having run. */
async function pruneEdgesIfCompleted(workspaceId: string, row: AgiTaskRow): Promise<void> {
  if (row.status !== 'done') return;
  await resolveCompletedBlocker(workspaceId, row.taskId);
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
        notInArray(agiTasks.status, terminalStatuses()),
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
  // A release may carry `status: done` (R-16's finish-and-hand-back), which is
  // the same completion event as a PATCH and resolves edges the same way.
  if (!row) return null;
  await pruneEdgesIfCompleted(input.workspaceId, row);
  return row;
}
