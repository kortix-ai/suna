/**
 * A team's shared task list (flag `agent_teams`, `@kortix/api-contract/multi-agent`):
 * the tasks of one lead session, numbered from 1. The lead creates them, a
 * teammate claims one, works it in its own session and completes it; a task
 * whose `blocked_by` tasks are not all completed is `blocked` and cannot be
 * claimed. Claude Code's agent teams share one task list the same way.
 *
 * A teammate is a child session whose metadata `team_lead` names the lead;
 * `owner` names a teammate by its `agent_handle`.
 *
 * The claim is ONE compare-and-set UPDATE: pending, unowned (or already the
 * caller's), and no unfinished blocker. Two teammates that claim the same task
 * at once get one row back between them: the loser of the row lock re-reads
 * the row, finds it `in_progress`, and matches nothing (`task_taken`).
 *
 * No Hono context here: the route resolves who calls (the lead, a teammate,
 * or a person) and passes plain values.
 */
import {
  SESSION_TASK_BLOCKED_CODE,
  SESSION_TASK_TAKEN_CODE,
  type SessionTask,
  type SessionTaskCreateBody,
  type SessionTaskUpdateBody,
} from '@kortix/api-contract/multi-agent';
import { projectSessions, sessionTasks } from '@kortix/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { sessionAgentHandle, sessionTeamLead } from '../lib/session-board';

export const AGENT_TEAMS_FLAG = 'agent_teams' as const;
/** Tasks one team may hold. */
export const TEAM_TASKS_MAX = 500;

export type TaskRow = typeof sessionTasks.$inferSelect;

export class TeamTaskError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly code: string) {
    super(message);
  }
}

/** Who calls: a session (the lead or a teammate) with its handle, or a person. */
export type TeamCaller =
  | { kind: 'session'; sessionId: string; handle: string; role: 'lead' | 'teammate' }
  | { kind: 'person'; userId: string };

/**
 * `true` when `metadata` makes the session a teammate of `leadSessionId`:
 * `team_lead` names the lead AND the lead created it (`spawned_by_session`,
 * server-managed). A `team_lead` alone is never trusted.
 */
export function isTeammateOf(metadata: unknown, leadSessionId: string): boolean {
  return sessionTeamLead(metadata) === leadSessionId &&
    ((metadata ?? {}) as Record<string, unknown>).spawned_by_session === leadSessionId;
}

/** The handle a team uses for a session: its `agent_handle`, else its agent name and short id. */
export function teamHandle(row: { sessionId: string; agentName: string | null; metadata: unknown }): string {
  const handle = sessionAgentHandle(row.metadata);
  if (handle) return handle;
  const agent = row.agentName && row.agentName !== 'default' ? row.agentName : 'session';
  return `${agent}-${row.sessionId.slice(0, 8)}`;
}

/** The live teammates of a lead (`metadata.team_lead`), oldest first. */
export async function listTeammates(leadSessionId: string) {
  return db
    .select({ sessionId: projectSessions.sessionId, agentName: projectSessions.agentName, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(
      sql`${projectSessions.metadata}->>'team_lead' = ${leadSessionId}`,
      sql`${projectSessions.metadata}->>'spawned_by_session' = ${leadSessionId}`,
      sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
    ))
    .orderBy(asc(projectSessions.createdAt))
    .limit(200);
}

/** The teammate (or the lead itself) a handle names, or null. */
async function resolveOwner(
  lead: { sessionId: string; agentName: string | null; metadata: unknown },
  handle: string,
): Promise<{ sessionId: string; handle: string } | null> {
  const wanted = handle.replace(/^@/, '');
  const members = [lead, ...(await listTeammates(lead.sessionId))];
  const found = members.find((m) => teamHandle(m) === wanted || m.sessionId === wanted);
  return found ? { sessionId: found.sessionId, handle: teamHandle(found) } : null;
}

export function serializeTask(row: TaskRow, statusBySeq: ReadonlyMap<number, string>): SessionTask {
  const blockedBy = [...(row.blockedBy ?? [])].sort((a, b) => a - b);
  return {
    seq: row.seq,
    lead_session_id: row.leadSessionId,
    subject: row.subject,
    description: row.description,
    status: row.status as SessionTask['status'],
    owner_handle: row.ownerHandle,
    owner_session_id: row.ownerSessionId,
    blocked_by: blockedBy,
    // A blocker that was deleted no longer blocks (the delete removes it from every list).
    blocked: blockedBy.some((seq) => statusBySeq.has(seq) && statusBySeq.get(seq) !== 'completed'),
    created_by_session_id: row.createdBySessionId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function teamRows(leadSessionId: string): Promise<TaskRow[]> {
  return db.select().from(sessionTasks).where(eq(sessionTasks.leadSessionId, leadSessionId)).orderBy(asc(sessionTasks.seq));
}

const statusMap = (rows: readonly TaskRow[]) => new Map(rows.map((row) => [row.seq, row.status]));

export async function listTasks(leadSessionId: string): Promise<SessionTask[]> {
  const rows = await teamRows(leadSessionId);
  const statuses = statusMap(rows);
  return rows.map((row) => serializeTask(row, statuses));
}

export async function getTask(leadSessionId: string, seq: number): Promise<SessionTask> {
  const rows = await teamRows(leadSessionId);
  const row = rows.find((r) => r.seq === seq);
  if (!row) throw new TeamTaskError(404, `No task #${seq} in this team`, 'task_not_found');
  return serializeTask(row, statusMap(rows));
}

/** Every number in `blockedBy` names a task of this team, and none is `self`. */
function assertBlockers(rows: readonly TaskRow[], blockedBy: readonly number[], self: number | null): void {
  const known = new Set(rows.map((row) => row.seq));
  for (const seq of blockedBy) {
    if (seq === self) throw new TeamTaskError(400, `Task #${seq} cannot wait for itself`, 'task_blocked_by_self');
    if (!known.has(seq)) throw new TeamTaskError(400, `No task #${seq} in this team`, 'task_not_found');
  }
}

/** True when making `seq` wait for `adding` closes a loop. */
function closesLoop(rows: readonly TaskRow[], seq: number, adding: readonly number[]): boolean {
  const edges = new Map(rows.map((row) => [row.seq, row.seq === seq ? [...row.blockedBy, ...adding] : row.blockedBy]));
  const seen = new Set<number>();
  const stack = [...adding];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === seq) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return false;
}

export async function createTask(input: {
  lead: { sessionId: string; projectId: string; agentName: string | null; metadata: unknown };
  body: SessionTaskCreateBody;
  createdBySessionId: string | null;
}): Promise<SessionTask> {
  const { lead, body } = input;
  const rows = await teamRows(lead.sessionId);
  if (rows.length >= TEAM_TASKS_MAX) throw new TeamTaskError(409, `A team holds at most ${TEAM_TASKS_MAX} tasks`, 'team_tasks_full');
  const blockedBy = [...new Set(body.blocked_by ?? [])];
  assertBlockers(rows, blockedBy, null);
  const owner = body.owner ? await resolveOwner(lead, body.owner) : null;
  if (body.owner && !owner) throw new TeamTaskError(400, `No teammate "${body.owner}" in this team`, 'unknown_teammate');
  // The next number, computed in the INSERT; a concurrent create that took it
  // first fails the (lead, seq) key and this one retries with the next.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [row] = await db.insert(sessionTasks).values({
        projectId: lead.projectId,
        leadSessionId: lead.sessionId,
        seq: sql`(select coalesce(max(s.seq), 0) + 1 from kortix.session_tasks s where s.lead_session_id = ${lead.sessionId})`,
        subject: body.subject,
        description: body.description ?? '',
        ownerHandle: owner?.handle ?? null,
        ownerSessionId: owner?.sessionId ?? null,
        blockedBy,
        createdBySessionId: input.createdBySessionId,
      }).returning();
      return serializeTask(row!, statusMap([...rows, row!]));
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (attempt < 4 && code === '23505') continue;
      throw err;
    }
  }
}

/**
 * Change one task. `claim` takes it for the calling session in one
 * compare-and-set; it combines with no other field but `description`.
 */
export async function updateTask(input: {
  lead: { sessionId: string; agentName: string | null; metadata: unknown };
  seq: number;
  body: SessionTaskUpdateBody;
  caller: TeamCaller;
}): Promise<SessionTask> {
  const { lead, seq, body, caller } = input;
  if (body.claim) {
    if (caller.kind !== 'session') throw new TeamTaskError(400, 'Only a session claims a task: assign it with owner', 'claim_needs_session');
    if (body.status !== undefined || body.owner !== undefined || body.add_blocked_by !== undefined) {
      throw new TeamTaskError(400, 'claim combines with no status, owner or add_blocked_by', 'claim_conflict');
    }
    return claimTask(lead.sessionId, seq, caller);
  }
  const rows = await teamRows(lead.sessionId);
  const row = rows.find((r) => r.seq === seq);
  if (!row) throw new TeamTaskError(404, `No task #${seq} in this team`, 'task_not_found');
  const statuses = statusMap(rows);
  const set: Partial<typeof sessionTasks.$inferInsert> = { updatedAt: new Date() };
  if (body.subject !== undefined) set.subject = body.subject;
  if (body.description !== undefined) set.description = body.description;
  if (body.add_blocked_by?.length) {
    const adding = [...new Set(body.add_blocked_by)].filter((s) => !row.blockedBy.includes(s));
    assertBlockers(rows, adding, seq);
    if (closesLoop(rows, seq, adding)) throw new TeamTaskError(400, `Task #${seq} would wait for itself through its blockers`, 'task_blocked_loop');
    set.blockedBy = [...row.blockedBy, ...adding];
  }
  if (body.owner !== undefined) {
    if (body.owner === null) {
      set.ownerHandle = null;
      set.ownerSessionId = null;
    } else {
      const owner = await resolveOwner(lead, body.owner);
      if (!owner) throw new TeamTaskError(400, `No teammate "${body.owner}" in this team`, 'unknown_teammate');
      set.ownerHandle = owner.handle;
      set.ownerSessionId = owner.sessionId;
    }
  }
  if (body.status !== undefined) {
    const blockers = (set.blockedBy as number[] | undefined) ?? row.blockedBy;
    const open = blockers.filter((s) => statuses.has(s) && statuses.get(s) !== 'completed');
    if (body.status === 'in_progress' && open.length > 0) {
      throw new TeamTaskError(409, `Task #${seq} waits for ${open.map((s) => `#${s}`).join(', ')}`, SESSION_TASK_BLOCKED_CODE);
    }
    set.status = body.status;
    // Starting an unowned task makes the calling session its owner.
    if (body.status === 'in_progress' && !row.ownerSessionId && body.owner === undefined && caller.kind === 'session') {
      set.ownerHandle = caller.handle;
      set.ownerSessionId = caller.sessionId;
    }
  }
  const [updated] = await db.update(sessionTasks).set(set)
    .where(and(eq(sessionTasks.leadSessionId, lead.sessionId), eq(sessionTasks.seq, seq)))
    .returning();
  if (!updated) throw new TeamTaskError(404, `No task #${seq} in this team`, 'task_not_found');
  return serializeTask(updated, statusMap(rows.map((r) => (r.seq === seq ? updated : r))));
}

async function claimTask(leadSessionId: string, seq: number, caller: Extract<TeamCaller, { kind: 'session' }>): Promise<SessionTask> {
  const claimed = await db.execute(sql`
    UPDATE kortix.session_tasks AS t
       SET status = 'in_progress',
           owner_session_id = ${caller.sessionId},
           owner_handle = ${caller.handle},
           updated_at = now()
     WHERE t.lead_session_id = ${leadSessionId}
       AND t.seq = ${seq}
       AND t.status = 'pending'
       AND (t.owner_session_id IS NULL OR t.owner_session_id = ${caller.sessionId})
       AND NOT EXISTS (
         SELECT 1 FROM kortix.session_tasks AS b
          WHERE b.lead_session_id = t.lead_session_id
            AND b.seq = ANY (t.blocked_by)
            AND b.status <> 'completed')
    RETURNING t.seq`);
  const won = ((claimed as { rows?: unknown[] }).rows ?? (claimed as unknown as unknown[])).length > 0;
  const task = await getTask(leadSessionId, seq);
  if (won) return task;
  if (task.blocked) {
    throw new TeamTaskError(409, `Task #${seq} waits for ${task.blocked_by.map((s) => `#${s}`).join(', ')}`, SESSION_TASK_BLOCKED_CODE);
  }
  throw new TeamTaskError(
    409,
    task.owner_handle ? `Task #${seq} is taken by ${task.owner_handle}` : `Task #${seq} is ${task.status.replace('_', ' ')}`,
    SESSION_TASK_TAKEN_CODE,
  );
}

/** Delete a task; tasks that waited for it no longer do. */
export async function deleteTask(leadSessionId: string, seq: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [gone] = await tx.delete(sessionTasks)
      .where(and(eq(sessionTasks.leadSessionId, leadSessionId), eq(sessionTasks.seq, seq)))
      .returning({ seq: sessionTasks.seq });
    if (!gone) throw new TeamTaskError(404, `No task #${seq} in this team`, 'task_not_found');
    await tx.update(sessionTasks)
      .set({ blockedBy: sql`array_remove(${sessionTasks.blockedBy}, ${seq}::integer)`, updatedAt: new Date() })
      .where(and(eq(sessionTasks.leadSessionId, leadSessionId), sql`${seq}::integer = ANY (${sessionTasks.blockedBy})`));
  });
}

/** The unfinished tasks `sessionId` owns, in number order: what its lead's notice names. */
export async function tasksOwnedBy(sessionId: string): Promise<Array<{ seq: number; subject: string; status: string }>> {
  return db.select({ seq: sessionTasks.seq, subject: sessionTasks.subject, status: sessionTasks.status })
    .from(sessionTasks)
    .where(and(eq(sessionTasks.ownerSessionId, sessionId), ne(sessionTasks.status, 'completed')))
    .orderBy(asc(sessionTasks.seq))
    .limit(20);
}

/** Load the rows a team route needs: the lead's session row. */
export async function loadLeadRow(projectId: string, leadSessionId: string) {
  const [row] = await db.select({
    sessionId: projectSessions.sessionId,
    projectId: projectSessions.projectId,
    agentName: projectSessions.agentName,
    metadata: projectSessions.metadata,
  }).from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, leadSessionId)))
    .limit(1);
  return row ?? null;
}

/** Runtime-context key kortixd gives a teammate: its lead's session id. */
export const TEAM_LEAD_RUNTIME_CONTEXT_KEY = 'kortix.team.lead' as const;
const AGENT_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_HANDLES = new Set(['parent', 'main']);

/**
 * `POST /projects/:id/sessions` with the multi-agent metadata a box sends for
 * a child (`agent({ name })`, a teammate). Null when the request may go on.
 *
 * - `team_lead` (and the runtime context `kortix.team.lead`) must name the
 *   creating session itself: a session never joins someone else's team.
 * - `agent_handle` is a plain name, unique among the parent's live children.
 */
export async function teamCreateMetadataError(input: {
  metadata: unknown;
  runtimeContext: unknown;
  callerSessionId: string | null;
  parentSessionId: string | null;
}): Promise<{ error: string; code: string; status: 400 | 409 } | null> {
  const meta = (input.metadata && typeof input.metadata === 'object' ? input.metadata : {}) as Record<string, unknown>;
  const context = (input.runtimeContext && typeof input.runtimeContext === 'object' ? input.runtimeContext : {}) as Record<string, unknown>;
  for (const lead of [meta.team_lead, context[TEAM_LEAD_RUNTIME_CONTEXT_KEY]]) {
    if (lead === undefined) continue;
    if (typeof lead !== 'string' || !input.callerSessionId || lead !== input.callerSessionId) {
      return { status: 400, code: 'team_lead_must_be_caller', error: 'team_lead must be the session that creates the teammate' };
    }
  }
  const handle = meta.agent_handle;
  if (handle === undefined) return null;
  if (typeof handle !== 'string' || !AGENT_HANDLE.test(handle) || RESERVED_HANDLES.has(handle)) {
    return { status: 400, code: 'invalid_agent_handle', error: 'agent_handle is 1-64 letters, digits, dots, dashes or underscores, and not parent or main' };
  }
  const parent = input.callerSessionId ?? input.parentSessionId;
  if (!parent) return null;
  const [taken] = await db.select({ sessionId: projectSessions.sessionId }).from(projectSessions).where(and(
    eq(projectSessions.parentSessionId, parent),
    sql`${projectSessions.metadata}->>'agent_handle' = ${handle}`,
    sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
    sql`${projectSessions.status} <> 'failed'`,
  )).limit(1);
  return taken
    ? { status: 409, code: 'agent_handle_taken', error: `Another live child of this session is already named "${handle}"` }
    : null;
}
