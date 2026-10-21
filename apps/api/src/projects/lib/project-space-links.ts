/**
 * Links pinned to a channel (`kortix.project_space_links`), the channel's
 * Links tab. The routes in `routes/project-spaces.ts` check the channel first
 * (`findLiveChannel`); these functions take its id as already checked.
 */
import type { SpaceLink, SpaceLinkCreateInput } from '@kortix/api-contract';
import { projectSpaceLinks } from '@kortix/db';
import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveSessionOwnerIdentities } from './user-identity';

type LinkRow = typeof projectSpaceLinks.$inferSelect;

/** Who asks: their id, and whether they manage the project (they may delete any link). */
export type LinkViewer = { userId: string; manager: boolean };

function serializeLink(row: LinkRow, viewer: LinkViewer, names: Map<string, { name: string | null }>): SpaceLink {
  return {
    link_id: row.linkId,
    space_id: row.spaceId,
    url: row.url,
    title: row.title,
    created_by: row.createdBy,
    created_by_name: (row.createdBy && names.get(row.createdBy)?.name) || null,
    created_at: row.createdAt.toISOString(),
    can_delete: viewer.manager || row.createdBy === viewer.userId,
  };
}

async function serializeLinks(rows: LinkRow[], viewer: LinkViewer, accountId: string): Promise<SpaceLink[]> {
  const creators = rows.flatMap((row) => (row.createdBy ? [row.createdBy] : []));
  const names = await resolveSessionOwnerIdentities(creators, accountId);
  return rows.map((row) => serializeLink(row, viewer, names));
}

/** Every link of the channel, newest first. */
export async function listSpaceLinks(spaceId: string, accountId: string, viewer: LinkViewer): Promise<SpaceLink[]> {
  const rows = await db
    .select()
    .from(projectSpaceLinks)
    .where(eq(projectSpaceLinks.spaceId, spaceId))
    .orderBy(desc(projectSpaceLinks.createdAt), desc(projectSpaceLinks.linkId));
  return serializeLinks(rows, viewer, accountId);
}

export async function addSpaceLink(
  projectId: string,
  spaceId: string,
  accountId: string,
  viewer: LinkViewer,
  input: SpaceLinkCreateInput,
): Promise<SpaceLink> {
  const [row] = await db
    .insert(projectSpaceLinks)
    .values({ projectId, spaceId, url: input.url, title: input.title || null, createdBy: viewer.userId })
    .returning();
  const [link] = await serializeLinks([row!], viewer, accountId);
  return link!;
}

/** `not_found` when the channel has no such link; `forbidden` unless the caller added it or manages the project. */
export async function deleteSpaceLink(
  spaceId: string,
  linkId: string,
  viewer: LinkViewer,
): Promise<'deleted' | 'not_found' | 'forbidden'> {
  const where = and(eq(projectSpaceLinks.spaceId, spaceId), eq(projectSpaceLinks.linkId, linkId));
  const [row] = await db.select({ createdBy: projectSpaceLinks.createdBy }).from(projectSpaceLinks).where(where).limit(1);
  if (!row) return 'not_found';
  if (!viewer.manager && row.createdBy !== viewer.userId) return 'forbidden';
  await db.delete(projectSpaceLinks).where(where);
  return 'deleted';
}

export async function countSpaceLinks(spaceId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(projectSpaceLinks).where(eq(projectSpaceLinks.spaceId, spaceId));
  return row?.n ?? 0;
}
