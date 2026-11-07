/**
 * Goals: the database reads and the one locked write path.
 *
 * Every lifecycle write goes through `writeGoal`: it locks the row
 * (`SELECT … FOR UPDATE`), lets the caller decide on the locked row, then in
 * the same transaction bumps `revision` (and `generation` when asked) and
 * appends one `project_goal_events` row. A refusal writes nothing.
 */
import { projectGoalEvents, projectGoals } from '@kortix/db';
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { projectsView } from '../../workspaces/rows';

export type GoalRow = typeof projectGoals.$inferSelect;
export type GoalEventRow = typeof projectGoalEvents.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface GoalEventInput {
  kind: string;
  actorKind: 'user' | 'session' | 'platform';
  actorId: string | null;
  message?: string;
  data?: Record<string, unknown>;
  dedupeKey?: string | null;
}

/** A refusal: the HTTP status and the contract error body (`GoalErrorSchema`). */
export class GoalError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: 'goal_conflict' | 'goal_forbidden' | 'goal_invalid' | 'goal_not_found' | 'goal_flag_off',
    message: string,
    readonly violations?: string[],
    readonly goal?: GoalRow,
  ) {
    super(message);
  }
}

export async function getGoal(projectId: string, goalId: string): Promise<GoalRow | null> {
  const [row] = await db
    .select()
    .from(projectGoals)
    .where(and(eq(projectGoals.projectId, projectId), eq(projectGoals.goalId, goalId)))
    .limit(1);
  return row ?? null;
}

export async function getGoalById(goalId: string): Promise<GoalRow | null> {
  const [row] = await db.select().from(projectGoals).where(eq(projectGoals.goalId, goalId)).limit(1);
  return row ?? null;
}

/** The project's goals, newest first. `where` narrows (a session sees only its own). */
export async function listGoals(projectId: string, where?: SQL): Promise<GoalRow[]> {
  return db
    .select()
    .from(projectGoals)
    .where(where ? and(eq(projectGoals.projectId, projectId), where) : eq(projectGoals.projectId, projectId))
    .orderBy(desc(projectGoals.createdAt))
    .limit(500);
}

/** The goal whose heartbeat is `reminderId`, if any. The admission gate's lookup on every reminder fire. */
export async function goalByHeartbeat(projectId: string, reminderId: string): Promise<GoalRow | null> {
  const [row] = await db
    .select()
    .from(projectGoals)
    .where(and(eq(projectGoals.projectId, projectId), eq(projectGoals.heartbeatReminderId, reminderId)))
    .limit(1);
  return row ?? null;
}

/** The goal a session works or worked for (owner, verifier, or an earlier one of either), newest first. */
export async function goalOfSession(sessionId: string): Promise<GoalRow | null> {
  const [row] = await db
    .select()
    .from(projectGoals)
    .where(
      or(
        eq(projectGoals.ownerSessionId, sessionId),
        eq(projectGoals.verifierSessionId, sessionId),
        // A session the goal used before (a verifier after a stop, an owner after a handover).
        sql`${projectGoals.sessions} @> ${JSON.stringify([{ id: sessionId }])}::jsonb`,
      ),
    )
    .orderBy(desc(projectGoals.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Is the project's `goals` flag on, read the way the routes and the admission gate read it? */
export async function goalFlagOn(projectId: string): Promise<boolean> {
  const [row] = await db.select({ metadata: projectsView.metadata }).from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return row ? resolveFeatureFlag(row.metadata, 'goals') : false;
}

export async function insertGoal(values: typeof projectGoals.$inferInsert, event: GoalEventInput): Promise<GoalRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(projectGoals).values(values).onConflictDoNothing().returning();
    if (!row) return null;
    await insertEvent(tx, row, event, null, row.state);
    return row;
  });
}

async function insertEvent(tx: Tx, goal: GoalRow, event: GoalEventInput, from: string | null, to: string | null): Promise<boolean> {
  const [row] = await tx
    .insert(projectGoalEvents)
    .values({
      goalId: goal.goalId,
      projectId: goal.projectId,
      kind: event.kind,
      actorKind: event.actorKind,
      actorId: event.actorId,
      fromState: from,
      toState: to,
      message: (event.message ?? '').slice(0, 2_000),
      data: event.data ?? {},
      dedupeKey: event.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: projectGoalEvents.id });
  return Boolean(row);
}

/** An event with no row change (a refused wake, a notification marker). False: its dedupe key already exists. */
export async function appendGoalEvent(goal: GoalRow, event: GoalEventInput): Promise<boolean> {
  return db.transaction((tx) => insertEvent(tx, goal, event, goal.state, goal.state));
}

export async function goalEventExists(goalId: string, dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectGoalEvents.id })
    .from(projectGoalEvents)
    .where(and(eq(projectGoalEvents.goalId, goalId), eq(projectGoalEvents.dedupeKey, dedupeKey)))
    .limit(1);
  return Boolean(row);
}

export type GoalPatch = Partial<Omit<typeof projectGoals.$inferInsert, 'goalId' | 'projectId' | 'revision' | 'generation'>>;

export type GoalDecision =
  | {
      patch: GoalPatch;
      event: GoalEventInput;
      bumpGeneration?: boolean;
      /** A runtime change (wake counters, a refused wake): no lifecycle move, so `revision` stays and no client sees a conflict. */
      keepRevision?: boolean;
    }
  /** Nothing to change; return the row as it is. */
  | { unchanged: true };

export interface WriteGoalResult {
  row: GoalRow;
  before: GoalRow;
  /** The decision's event dedupe key already existed: nothing was written. */
  deduped: boolean;
  changed: boolean;
}

/**
 * The one lifecycle write. `decide` runs on the LOCKED row and returns the
 * change, or throws a `GoalError`. `now` is the database clock of the
 * transaction (`now()`), the one clock every goal decision reads.
 */
export async function writeGoal(
  projectId: string,
  goalId: string,
  decide: (row: GoalRow, now: Date) => GoalDecision | Promise<GoalDecision>,
  opts: { now?: Date } = {},
): Promise<WriteGoalResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(projectGoals)
      .where(and(eq(projectGoals.projectId, projectId), eq(projectGoals.goalId, goalId)))
      .for('update')
      .limit(1);
    if (!row) throw new GoalError(404, 'goal_not_found', 'Goal not found.');
    const now = opts.now ?? (await dbNow(tx));
    const decision = await decide(row, now);
    if ('unchanged' in decision) return { row, before: row, deduped: false, changed: false };
    if (decision.event.dedupeKey) {
      const [seen] = await tx
        .select({ id: projectGoalEvents.id })
        .from(projectGoalEvents)
        .where(and(eq(projectGoalEvents.goalId, goalId), eq(projectGoalEvents.dedupeKey, decision.event.dedupeKey)))
        .limit(1);
      if (seen) return { row, before: row, deduped: true, changed: false };
    }
    const [updated] = await tx
      .update(projectGoals)
      .set({
        ...decision.patch,
        ...(decision.keepRevision ? {} : { revision: sql`${projectGoals.revision} + 1` }),
        ...(decision.bumpGeneration ? { generation: sql`${projectGoals.generation} + 1` } : {}),
        updatedAt: now,
      })
      .where(eq(projectGoals.goalId, goalId))
      .returning();
    await insertEvent(tx, updated!, decision.event, row.state, updated!.state);
    return { row: updated!, before: row, deduped: false, changed: true };
  });
}

/** Columns the platform keeps up to date without a lifecycle revision (heartbeat id, next wake). */
export async function setGoalRuntimeFields(goalId: string, patch: Pick<GoalPatch, 'heartbeatReminderId' | 'nextWakeAt' | 'setup'>): Promise<void> {
  await db.update(projectGoals).set(patch).where(eq(projectGoals.goalId, goalId));
}

/**
 * Install `next` as the goal's heartbeat only while the row still names
 * `expected` (compare-and-set). False: another writer installed one first.
 */
export async function installGoalHeartbeat(goalId: string, expected: string | null, next: string, nextWakeAt: Date | null): Promise<boolean> {
  const rows = await db
    .update(projectGoals)
    .set({ heartbeatReminderId: next, nextWakeAt })
    .where(and(eq(projectGoals.goalId, goalId), sql`${projectGoals.heartbeatReminderId} is not distinct from ${expected}`))
    .returning({ id: projectGoals.goalId });
  return rows.length === 1;
}

/** Set one `setup` key without rewriting the rest (a remembered prompt may land in between). */
export async function setGoalSetupKey(goalId: string, key: string, value: unknown): Promise<void> {
  await db.execute(sql`update kortix.project_goals set setup = jsonb_set(setup, ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb) where goal_id = ${goalId}`);
}

export interface PendingGoalPrompt {
  sessionId: string;
  userId: string | null;
  text: string;
  key: string;
}

/** Remember a prompt that did not queue (`setup.pending_prompts`, one per key); the reconciler queues it later. */
export async function rememberGoalPrompt(goalId: string, prompt: PendingGoalPrompt): Promise<void> {
  await db.execute(sql`
    update kortix.project_goals
       set setup = jsonb_set(setup, '{pending_prompts}',
             coalesce((select jsonb_agg(p) from jsonb_array_elements(setup->'pending_prompts') p where p->>'key' <> ${prompt.key}), '[]'::jsonb)
             || jsonb_build_array(${JSON.stringify(prompt)}::jsonb))
     where goal_id = ${goalId}`);
}

/** Drop the remembered prompts with these keys (queued, or moot on a closed goal). */
export async function forgetGoalPrompts(goalId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await db.execute(sql`
    update kortix.project_goals
       set setup = jsonb_set(setup, '{pending_prompts}',
             coalesce((select jsonb_agg(p) from jsonb_array_elements(setup->'pending_prompts') p where not (p->>'key' = any(array[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]))), '[]'::jsonb))
     where goal_id = ${goalId}`);
}

export function pendingGoalPrompts(goal: Pick<GoalRow, 'setup'>): PendingGoalPrompt[] {
  const list = (goal.setup as { pending_prompts?: unknown }).pending_prompts;
  return Array.isArray(list) ? (list as PendingGoalPrompt[]) : [];
}

export async function dbNow(q: Pick<typeof db, 'execute'> = db): Promise<Date> {
  const result = await q.execute(sql`select now() as now`);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ now: string | Date }>;
  const value = rows[0]?.now;
  return value instanceof Date ? value : new Date(String(value));
}

/** A page of a goal's events, newest first. `cursor` is the `at|id` of the last event of the previous page. */
export async function listGoalEvents(goalId: string, cursor: string | null, limit = 50): Promise<{ rows: GoalEventRow[]; next: string | null }> {
  let where: SQL = eq(projectGoalEvents.goalId, goalId);
  if (cursor) {
    const [atIso, id] = cursor.split('|');
    const at = new Date(atIso ?? '');
    if (!Number.isNaN(at.getTime()) && id) {
      where = and(
        where,
        or(lt(projectGoalEvents.at, at), and(eq(projectGoalEvents.at, at), lt(projectGoalEvents.id, id))),
      )!;
    }
  }
  const rows = await db
    .select()
    .from(projectGoalEvents)
    .where(where)
    .orderBy(desc(projectGoalEvents.at), desc(projectGoalEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > limit && last ? `${last.at.toISOString()}|${last.id}` : null };
}

/** Goals the reconciler looks at: open ones, plus closed ones that still hold a heartbeat. */
export async function goalsToReconcile(limit: number, afterGoalId: string | null): Promise<GoalRow[]> {
  const open = inArray(projectGoals.state, ['draft', 'active', 'waiting_on_user', 'verifying']);
  const leftover = sql`${projectGoals.heartbeatReminderId} is not null`;
  const scope = or(open, leftover)!;
  return db
    .select()
    .from(projectGoals)
    .where(afterGoalId ? and(scope, sql`${projectGoals.goalId} > ${afterGoalId}::uuid`) : scope)
    .orderBy(projectGoals.goalId)
    .limit(limit);
}

/** A goal already uses this folder of this drive. */
export async function goalFolderTaken(projectId: string, driveId: string, folder: string): Promise<boolean> {
  const [row] = await db
    .select({ goalId: projectGoals.goalId })
    .from(projectGoals)
    .where(and(eq(projectGoals.projectId, projectId), eq(projectGoals.driveId, driveId), eq(projectGoals.folder, folder)))
    .limit(1);
  return Boolean(row);
}
