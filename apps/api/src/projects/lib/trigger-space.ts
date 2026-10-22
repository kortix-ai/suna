/**
 * The channel or DM a trigger posts its runs to (`project_trigger_runtime.space_id`,
 * flag `project_channels`). Account-local like the trigger's access policy, so it
 * is not in the repo manifest. The routes validate it on write
 * (`resolveTriggerSpace`); session create reads it for every run of the trigger
 * (`liveTriggerSpace`), so a queued run resolves the space when it executes.
 */
import type { TriggerSessionAccess } from '@kortix/api-contract';
import { projectSpaces, projectTriggerRuntime } from '@kortix/db';
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { SPACE_NOT_FOUND } from './project-spaces';

type SpaceRow = typeof projectSpaces.$inferSelect;

export type TriggerSpaceError = {
  status: 400 | 403 | 404;
  body: { error: string; code: string };
};

/** A channel trigger with no explicit policy: its threads are project-visible, like any channel thread. */
export const PROJECT_TRIGGER_SESSION_ACCESS: TriggerSessionAccess = { mode: 'project', memberIds: [], groupIds: [] };

/**
 * A DM trigger's policy, whatever the caller asked for. Its runs are attributed
 * to the agent's service account, so `private` would hide them from the DM's
 * own member: the thread is shared with that one member instead.
 */
export function dmTriggerSessionAccess(space: SpaceRow): TriggerSessionAccess {
  return { mode: 'members', memberIds: [space.dmUserId!], groupIds: [] };
}

/**
 * The space a caller may point a trigger at: a live channel of the project or
 * the caller's own live DM. An unknown, archived or foreign id is 404; another
 * member's DM is 403.
 */
export async function resolveTriggerSpace(
  projectId: string,
  spaceId: unknown,
  userId: string,
): Promise<{ space: SpaceRow } | { error: TriggerSpaceError }> {
  if (typeof spaceId !== 'string') {
    return { error: { status: 400, body: { error: 'space_id must be a channel or DM id, or null', code: 'invalid_space_id' } } };
  }
  const [row] = isUuid(spaceId)
    ? await db
        .select()
        .from(projectSpaces)
        .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId), isNull(projectSpaces.archivedAt)))
        .limit(1)
    : [];
  if (!row) return { error: { status: 404, body: SPACE_NOT_FOUND } };
  if (row.kind === 'dm' && row.dmUserId !== userId) {
    return {
      error: { status: 403, body: { error: 'Only the member a DM belongs to can post a trigger to it.', code: 'space_forbidden' } },
    };
  }
  return { space: row };
}

/** The space stored on a trigger, archived or not; null when it has none. */
export async function loadTriggerSpace(projectId: string, slug: string): Promise<SpaceRow | null> {
  const [row] = await db
    .select({ space: projectSpaces })
    .from(projectTriggerRuntime)
    .innerJoin(projectSpaces, eq(projectSpaces.spaceId, projectTriggerRuntime.spaceId))
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)))
    .limit(1);
  return row?.space ?? null;
}

/** The space a run of this trigger lands in now: null when it has none or the space is archived. */
export async function liveTriggerSpace(projectId: string, slug: string): Promise<SpaceRow | null> {
  const space = await loadTriggerSpace(projectId, slug);
  return space && !space.archivedAt ? space : null;
}

export async function setTriggerSpace(projectId: string, slug: string, spaceId: string | null): Promise<void> {
  await db
    .update(projectTriggerRuntime)
    .set({ spaceId, updatedAt: new Date() })
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)));
}

/**
 * Triggers that post to a space: runtime rows, not the manifest, so the count
 * needs no git read. ponytail: a trigger deleted from the manifest outside the
 * API keeps its runtime row until the next trigger write reconciles it.
 */
export async function countSpaceTriggers(spaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(projectTriggerRuntime)
    .where(eq(projectTriggerRuntime.spaceId, spaceId));
  return row?.n ?? 0;
}
