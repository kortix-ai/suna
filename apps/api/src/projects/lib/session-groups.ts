/**
 * Session groups: named folders of a project's sessions in the sidebar, one
 * table `kortix.project_session_groups`, behind the `session_groups` flag. The
 * routes live in `routes/session-groups.ts`.
 *
 * Every project member sees the same groups in the same order (`position`,
 * 0-based, no gaps). A session is in at most one group of its own project
 * (`project_sessions.group_id`). Filing a session never touches its
 * `updated_at`, so it keeps its place in every activity-ordered list. Deleting
 * a group leaves its sessions in no group (the FK's ON DELETE SET NULL).
 *
 * Every write that reads or changes the order takes the project's advisory
 * lock first, so two creates never take one position and a reorder never
 * races a create or a delete.
 */
import { SESSION_GROUPS_MAX } from '@kortix/api-contract';
import { projectSessionGroups, projectSessions } from '@kortix/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { errorSqlstate } from '../../shared/error-cause';
import { uniqueViolationConstraint } from '../../shared/postgres-errors';

export type SessionGroupRow = typeof projectSessionGroups.$inferSelect;

const NAME_INDEX = 'uniq_project_session_groups_name';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function lockProjectGroups(tx: Tx, projectId: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session-groups:${projectId}`}))`);
}

function groupsOf(executor: Tx | typeof db, projectId: string) {
  return executor
    .select()
    .from(projectSessionGroups)
    .where(eq(projectSessionGroups.projectId, projectId))
    .orderBy(asc(projectSessionGroups.position), asc(projectSessionGroups.createdAt), asc(projectSessionGroups.groupId));
}

/** The project's groups, in order. */
export function listSessionGroups(projectId: string): Promise<SessionGroupRow[]> {
  return groupsOf(db, projectId);
}

/** A new group, last in the order. `name` is already trimmed (the contract schema). */
export async function createSessionGroup(input: {
  accountId: string;
  projectId: string;
  name: string;
  createdBy: string | null;
}): Promise<{ ok: true; group: SessionGroupRow } | { ok: false; code: 'group_name_taken' | 'group_limit' }> {
  try {
    return await db.transaction(async (tx) => {
      await lockProjectGroups(tx, input.projectId);
      const existing = await groupsOf(tx, input.projectId);
      if (existing.length >= SESSION_GROUPS_MAX) return { ok: false as const, code: 'group_limit' as const };
      const [group] = await tx
        .insert(projectSessionGroups)
        .values({
          accountId: input.accountId,
          projectId: input.projectId,
          name: input.name,
          position: existing.length,
          createdBy: input.createdBy,
        })
        .returning();
      return { ok: true as const, group: group! };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === NAME_INDEX) return { ok: false, code: 'group_name_taken' };
    throw error;
  }
}

/** Rename a group of the project. Its own name in another case is free. */
export async function renameSessionGroup(
  projectId: string,
  groupId: string,
  name: string,
): Promise<{ ok: true; group: SessionGroupRow } | { ok: false; code: 'group_name_taken' | 'group_not_found' }> {
  try {
    const [group] = await db
      .update(projectSessionGroups)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)))
      .returning();
    return group ? { ok: true, group } : { ok: false, code: 'group_not_found' };
  } catch (error) {
    if (uniqueViolationConstraint(error) === NAME_INDEX) return { ok: false, code: 'group_name_taken' };
    throw error;
  }
}

/**
 * Put the project's groups in this order. `groupIds` must name every group of
 * the project exactly once; otherwise nothing changes and the answer is
 * `group_order_stale` (the caller's list is out of date).
 */
export async function reorderSessionGroups(
  projectId: string,
  groupIds: readonly string[],
): Promise<{ ok: true; groups: SessionGroupRow[] } | { ok: false; code: 'group_order_stale' }> {
  return db.transaction(async (tx) => {
    await lockProjectGroups(tx, projectId);
    const existing = await groupsOf(tx, projectId);
    const known = new Set(existing.map((group) => group.groupId));
    if (
      groupIds.length !== existing.length ||
      new Set(groupIds).size !== groupIds.length ||
      groupIds.some((id) => !known.has(id))
    ) {
      return { ok: false as const, code: 'group_order_stale' as const };
    }
    const now = new Date();
    for (const [position, groupId] of groupIds.entries()) {
      const current = existing.find((group) => group.groupId === groupId)!;
      if (current.position === position) continue;
      await tx
        .update(projectSessionGroups)
        .set({ position, updatedAt: now })
        .where(eq(projectSessionGroups.groupId, groupId));
    }
    return { ok: true as const, groups: await groupsOf(tx, projectId) };
  });
}

/** Delete a group of the project; its sessions go to no group and the rest close up. False when there is no such group. */
export async function deleteSessionGroup(projectId: string, groupId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockProjectGroups(tx, projectId);
    const [deleted] = await tx
      .delete(projectSessionGroups)
      .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)))
      .returning({ position: projectSessionGroups.position });
    if (!deleted) return false;
    await tx
      .update(projectSessionGroups)
      .set({ position: sql`${projectSessionGroups.position} - 1` })
      .where(
        and(
          eq(projectSessionGroups.projectId, projectId),
          sql`${projectSessionGroups.position} > ${deleted.position}`,
        ),
      );
    return true;
  });
}

/**
 * File a session of the project into one of the project's groups, or into no
 * group (`null`). `updated_at` is left as it is. The caller has already checked
 * that the person may see the session.
 */
export async function setSessionGroup(
  projectId: string,
  sessionId: string,
  groupId: string | null,
): Promise<{ ok: true; groupId: string | null } | { ok: false; code: 'group_not_found' | 'session_not_found' }> {
  if (groupId !== null) {
    const [group] = await db
      .select({ groupId: projectSessionGroups.groupId })
      .from(projectSessionGroups)
      .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)));
    if (!group) return { ok: false, code: 'group_not_found' };
  }
  try {
    const [row] = await db
      .update(projectSessions)
      .set({ groupId })
      .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
      .returning({ groupId: projectSessions.groupId });
    return row ? { ok: true, groupId: row.groupId } : { ok: false, code: 'session_not_found' };
  } catch (error) {
    // The group was deleted between the read above and this write: the FK
    // refuses the stale id (23503).
    if (errorSqlstate(error) === '23503') return { ok: false, code: 'group_not_found' };
    throw error;
  }
}
