/**
 * Every statement the AGI human-request surface issues.
 *
 * The same two rules the task and observation stores follow:
 *   • every read and every write filters on `workspace_id`, so a request id from
 *     another workspace is invisible rather than forbidden;
 *   • the server clock decides `delivered_at` and `satisfied_at`, never a caller.
 *     A client that could stamp its own delivery could declare an ask delivered
 *     that it never sent, which is the exact lie §4.3 exists to prevent.
 */
import { db } from '../../shared/db';
import type { AgiRequestRow, DeliverySurface, RequestKind } from './wire';
import { accountMembers, agiRequests, agiTasks, projectMembers } from '@kortix/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

const NOW = sql`now()`;

export interface CreateRequestInput {
  workspaceId: string;
  taskId: string;
  kind: RequestKind;
  need: string;
  why: string | null;
  url: string | null;
  responderUserId: string | null;
  requestedBySessionId: string | null;
  originFingerprint: string;
}

/**
 * R-20 applied to asking a human, in one statement.
 *
 * The unique index deduplicates, so a standing daily `push` that re-derives the
 * same block every morning races into the SAME row rather than checking first.
 * `created:false` means the ask already existed — and the caller must then NOT
 * re-deliver it, which is the whole reason this returns the flag instead of
 * swallowing the conflict.
 *
 * Note what is not here: `delivered_at`. A request is born UNDELIVERED and is
 * marked delivered only by {@link markRequestDelivered}, after a surface actually
 * accepted it. Setting both in one insert would make "recorded" and "delivered"
 * the same event, and they are the two halves of R-12g.
 */
export async function createRequest(
  input: CreateRequestInput,
): Promise<{ row: AgiRequestRow; created: boolean }> {
  const [inserted] = await db
    .insert(agiRequests)
    .values({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      kind: input.kind,
      need: input.need,
      why: input.why,
      url: input.url,
      responderUserId: input.responderUserId,
      requestedBySessionId: input.requestedBySessionId,
      originFingerprint: input.originFingerprint,
    })
    // `where` here is the index PREDICATE, not a row filter — drizzle emits it
    // after the conflict target, which is what a partial unique index requires.
    .onConflictDoNothing({
      target: [agiRequests.workspaceId, agiRequests.originFingerprint],
      where: sql`origin_fingerprint is not null`,
    })
    .returning();

  if (inserted) return { row: inserted, created: true };

  const [existing] = await db
    .select()
    .from(agiRequests)
    .where(
      and(
        eq(agiRequests.workspaceId, input.workspaceId),
        eq(agiRequests.originFingerprint, input.originFingerprint),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('agi request insert conflicted but the conflicting row is gone');
  return { row: existing, created: false };
}

/**
 * Record that the ask reached a surface a human sees (R-12g).
 *
 * Guarded on `delivered_at is null` so it is write-once: two concurrent creates
 * that both raced to deliver cannot overwrite the first delivery's surface, and
 * a later re-delivery attempt cannot silently re-stamp an old ask as fresh.
 * Returns null when it matched nothing, which the caller reads as "already
 * delivered" rather than as a failure.
 */
export async function markRequestDelivered(input: {
  workspaceId: string;
  requestId: string;
  via: DeliverySurface;
}): Promise<AgiRequestRow | null> {
  const [row] = await db
    .update(agiRequests)
    .set({ deliveredAt: NOW, deliveredVia: input.via, updatedAt: NOW })
    .where(
      and(
        eq(agiRequests.requestId, input.requestId),
        eq(agiRequests.workspaceId, input.workspaceId),
        sql`${agiRequests.deliveredAt} is null`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function loadRequest(
  workspaceId: string,
  requestId: string,
): Promise<AgiRequestRow | null> {
  const [row] = await db
    .select()
    .from(agiRequests)
    .where(and(eq(agiRequests.requestId, requestId), eq(agiRequests.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/**
 * Close a request (R-12g's other end).
 *
 * Guarded on `status = 'pending'`, so the first responder wins and a second
 * answer matches zero rows instead of overwriting who actually supplied it. The
 * note is APPENDED to `why` rather than replacing it: the ask and the answer are
 * both evidence, and a human reading this later needs to see what was asked.
 */
export async function resolveRequest(input: {
  workspaceId: string;
  requestId: string;
  status: 'satisfied' | 'cancelled';
  userId: string;
  note: string | null;
}): Promise<AgiRequestRow | null> {
  const [row] = await db
    .update(agiRequests)
    .set({
      status: input.status,
      // The satisfied-coherent CHECK ties these together: only `satisfied`
      // carries a timestamp, so a cancelled row can never be mistaken for one
      // that was actually answered.
      satisfiedAt: input.status === 'satisfied' ? NOW : null,
      satisfiedByUserId: input.status === 'satisfied' ? input.userId : null,
      ...(input.note
        ? {
            why: sql`case when ${agiRequests.why} is null then ${input.note} else ${agiRequests.why} || E'\n\n' || ${input.note} end`,
          }
        : {}),
      updatedAt: NOW,
    })
    .where(
      and(
        eq(agiRequests.requestId, input.requestId),
        eq(agiRequests.workspaceId, input.workspaceId),
        eq(agiRequests.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The pending request for each of the named tasks — the liveness join.
 *
 * ONE query for every open task in the workspace, served by
 * `idx_agi_requests_task_pending`. A task with several pending asks keeps the
 * OLDEST: the first thing a human was asked for is the thing that has been
 * ignored longest, and it is the one worth naming in a stall report.
 */
export async function loadPendingRequestsByTask(
  workspaceId: string,
  taskIds: readonly string[],
): Promise<Map<string, AgiRequestRow>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(agiRequests)
    .where(
      and(
        eq(agiRequests.workspaceId, workspaceId),
        inArray(agiRequests.taskId, [...taskIds]),
        eq(agiRequests.status, 'pending'),
      ),
    )
    .orderBy(asc(agiRequests.createdAt), asc(agiRequests.requestId));

  const byTask = new Map<string, AgiRequestRow>();
  for (const row of rows) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, row);
  }
  return byTask;
}

export interface RequestListFilters {
  taskId?: string;
  /** A specific responder, or `me` resolved by the route to the caller. */
  responderUserId?: string;
  status?: string;
  limit: number;
}

/**
 * The inbox read: "what is waiting on you".
 *
 * OLDEST first, unlike every other list in this surface. That is deliberate and
 * it is the opposite of a feed: the ask that has gone unanswered longest is the
 * one doing the most damage, and burying it under this morning's fresh ones is
 * how a queue of blocked work becomes invisible again.
 */
export async function listRequests(
  workspaceId: string,
  filters: RequestListFilters,
): Promise<AgiRequestRow[]> {
  const conditions = [eq(agiRequests.workspaceId, workspaceId)];
  if (filters.taskId) conditions.push(eq(agiRequests.taskId, filters.taskId));
  if (filters.responderUserId) {
    conditions.push(eq(agiRequests.responderUserId, filters.responderUserId));
  }
  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(agiRequests.status, filters.status));
  }

  return db
    .select()
    .from(agiRequests)
    .where(and(...conditions))
    .orderBy(asc(agiRequests.createdAt), asc(agiRequests.requestId))
    .limit(filters.limit);
}

/** Titles for the tasks a list of requests points at, so an inbox row can say
 *  what work is blocked without the caller making N round trips. */
export async function loadTaskTitles(
  workspaceId: string,
  taskIds: readonly string[],
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({ taskId: agiTasks.taskId, title: agiTasks.title })
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), inArray(agiTasks.taskId, [...taskIds])));
  return new Map(rows.map((row) => [row.taskId, row.title]));
}

/**
 * Is this user someone the workspace can actually address?
 *
 * Checked before a responder is accepted, because the delivery-addressed CHECK
 * only proves a uuid is PRESENT — not that it belongs to anyone who can see the
 * project. An ask addressed to a stranger is delivered to nobody while reading
 * as healthy, which is the failure this whole module is about.
 */
export async function isWorkspaceResponder(input: {
  workspaceId: string;
  accountId: string;
  userId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, input.accountId), eq(accountMembers.userId, input.userId)),
    )
    .limit(1);
  if (row) return true;

  const [member] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, input.workspaceId),
        eq(projectMembers.userId, input.userId),
      ),
    )
    .limit(1);
  return member !== undefined;
}

/**
 * Who to ask when the caller did not say.
 *
 * Owner first, then admin, then any account member — newest membership last, so
 * the answer is stable rather than whatever the planner happened to return. This
 * is the same principal `resolveTriggerActor` runs unattended work as and the
 * same one R-32 escalates to, so an unattended run's asks land on the person who
 * already owns its failures.
 *
 * Null is a real answer and the route must handle it: an account with no members
 * at all cannot be asked anything, and the resulting undelivered request is what
 * makes that visible instead of silent.
 */
export async function resolveDefaultResponder(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountMembers.userId, role: accountMembers.accountRole })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId))
    .orderBy(
      sql`case ${accountMembers.accountRole} when 'owner' then 0 when 'admin' then 1 else 2 end`,
      asc(accountMembers.userId),
    )
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Requests that were recorded but never sent anywhere — the R-12g failure, as a
 * direct query.
 *
 * Worth having as its own read rather than a filter: it is the one list that
 * means "the system tried to reach a human and could not", and it should be
 * askable without first knowing which task or which responder to ask about.
 */
export async function listUndeliveredRequests(
  workspaceId: string,
  limit: number,
): Promise<AgiRequestRow[]> {
  return db
    .select()
    .from(agiRequests)
    .where(
      and(
        eq(agiRequests.workspaceId, workspaceId),
        eq(agiRequests.status, 'pending'),
        sql`${agiRequests.deliveredAt} is null`,
      ),
    )
    .orderBy(asc(agiRequests.createdAt), asc(agiRequests.requestId))
    .limit(limit);
}
