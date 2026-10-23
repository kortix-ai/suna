/**
 * A channel's links (`kortix.project_space_links`), its Links tab: the links
 * members added ("Add link", pinned) and the links people shared in its
 * threads (collected, unpinned until a member pins one). Agents read the
 * pinned ones (`drives/service.ts`). The routes in `routes/project-spaces.ts`
 * check the channel first (`findLiveChannel`); these functions take its id as
 * already checked.
 */
import type { SpaceLink, SpaceLinkCreateInput } from '@kortix/api-contract';
import { projectSpaceLinks } from '@kortix/db';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { extractMessageLinks } from './message-links';
import { findLiveChannel } from './project-spaces';
import { resolveSessionOwnerIdentities } from './user-identity';

type LinkRow = typeof projectSpaceLinks.$inferSelect;

/** The most pinned links one channel holds; pinning past it gets 409 `link_limit`. */
export const SPACE_LINKS_MAX = 200;
/** The most unpinned (collected) links one channel keeps; the least recently shared go first. */
export const SPACE_SHARED_LINKS_MAX = 500;

/** Who asks: their id, and whether they manage the project (they may delete any link). */
export type LinkViewer = { userId: string; manager: boolean };

function serializeLink(row: LinkRow, viewer: LinkViewer, names: Map<string, { name: string | null }>): SpaceLink {
  // A link "Add link" made before pinned_by existed was pinned by its creator.
  const pinnedBy = row.pinned ? (row.pinnedBy ?? row.createdBy) : null;
  return {
    link_id: row.linkId,
    space_id: row.spaceId,
    url: row.url,
    title: row.title,
    created_by: row.createdBy,
    created_by_name: (row.createdBy && names.get(row.createdBy)?.name) || null,
    created_at: row.createdAt.toISOString(),
    can_delete: viewer.manager || row.createdBy === viewer.userId,
    pinned: row.pinned,
    pinned_by_name: (pinnedBy && names.get(pinnedBy)?.name) || null,
    pinned_at: row.pinned ? (row.pinnedAt ?? row.createdAt).toISOString() : null,
    source: row.source,
    session_id: row.sessionId,
    share_count: row.shareCount,
    last_shared_at: row.lastSharedAt.toISOString(),
  };
}

async function serializeLinks(rows: LinkRow[], viewer: LinkViewer, accountId: string): Promise<SpaceLink[]> {
  const people = rows.flatMap((row) => [row.createdBy, row.pinnedBy].filter((id): id is string => !!id));
  const names = await resolveSessionOwnerIdentities(people, accountId);
  return rows.map((row) => serializeLink(row, viewer, names));
}

/** Every link of the channel, the most recently shared first. */
export async function listSpaceLinks(spaceId: string, accountId: string, viewer: LinkViewer): Promise<SpaceLink[]> {
  const rows = await db
    .select()
    .from(projectSpaceLinks)
    .where(eq(projectSpaceLinks.spaceId, spaceId))
    .orderBy(desc(projectSpaceLinks.lastSharedAt), desc(projectSpaceLinks.createdAt), desc(projectSpaceLinks.linkId));
  return serializeLinks(rows, viewer, accountId);
}

/**
 * Add and pin a link. The URL is stored as the URL parser serializes it (the
 * schema already checked it parses as http(s)), so spaces and the like reach
 * the README and the `href` encoded. A URL the channel already holds is pinned
 * (and takes the new title), not duplicated. `link_limit` at `SPACE_LINKS_MAX`
 * pinned links.
 */
export async function addSpaceLink(
  projectId: string,
  spaceId: string,
  accountId: string,
  viewer: LinkViewer,
  input: SpaceLinkCreateInput,
): Promise<SpaceLink | 'link_limit'> {
  // ponytail: count-then-insert, so two concurrent adds can pass 200 by one each; a per-space lock if that matters.
  if ((await countPinnedLinks(spaceId)) >= SPACE_LINKS_MAX) return 'link_limit';
  const url = new URL(input.url).href;
  const t = projectSpaceLinks;
  const now = new Date();
  const [row] = await db
    .insert(t)
    .values({ projectId, spaceId, url, title: input.title || null, createdBy: viewer.userId, pinnedBy: viewer.userId, pinnedAt: now })
    .onConflictDoUpdate({
      target: [t.spaceId, t.url],
      set: {
        pinned: true,
        // Already pinned: whoever pinned it first keeps the credit.
        pinnedBy: sql`case when ${t.pinned} then ${t.pinnedBy} else excluded.pinned_by end`,
        pinnedAt: sql`case when ${t.pinned} then ${t.pinnedAt} else excluded.pinned_at end`,
        title: sql`coalesce(excluded.title, ${t.title})`,
      },
    })
    .returning();
  const [link] = await serializeLinks([row!], viewer, accountId);
  return link!;
}

/**
 * Pin or unpin a link; any member who sees the channel may. Unpinning a link
 * no thread shared ("Add link" only) removes it, so only its creator or a
 * project manager may: `removed`. `link_limit` at `SPACE_LINKS_MAX` pinned.
 */
export async function pinSpaceLink(
  spaceId: string,
  linkId: string,
  accountId: string,
  viewer: LinkViewer,
  pinned: boolean,
): Promise<SpaceLink | 'removed' | 'not_found' | 'forbidden' | 'link_limit'> {
  const where = and(eq(projectSpaceLinks.spaceId, spaceId), eq(projectSpaceLinks.linkId, linkId));
  const [row] = await db.select().from(projectSpaceLinks).where(where).limit(1);
  if (!row) return 'not_found';
  let next = row;
  if (pinned && !row.pinned) {
    if ((await countPinnedLinks(spaceId)) >= SPACE_LINKS_MAX) return 'link_limit';
    [next] = await db
      .update(projectSpaceLinks)
      .set({ pinned: true, pinnedBy: viewer.userId, pinnedAt: new Date() })
      .where(where)
      .returning();
  } else if (!pinned && row.pinned) {
    if (row.source === 'manual' && row.sessionId === null) {
      if (!viewer.manager && row.createdBy !== viewer.userId) return 'forbidden';
      await db.delete(projectSpaceLinks).where(where);
      return 'removed';
    }
    [next] = await db
      .update(projectSpaceLinks)
      .set({ pinned: false, pinnedBy: null, pinnedAt: null })
      .where(where)
      .returning();
  }
  const [link] = await serializeLinks([next!], viewer, accountId);
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

/** Every link of the channel, pinned or shared: the Links tab count. */
export async function countSpaceLinks(spaceId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(projectSpaceLinks).where(eq(projectSpaceLinks.spaceId, spaceId));
  return row?.n ?? 0;
}

async function countPinnedLinks(spaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(projectSpaceLinks)
    .where(and(eq(projectSpaceLinks.spaceId, spaceId), eq(projectSpaceLinks.pinned, true)));
  return row?.n ?? 0;
}

/**
 * Save the links in a person's message to the channel of its thread. Only a
 * thread every project member sees (`project` visibility) of a live channel:
 * a DM or a private thread shares nothing. An address the channel holds keeps
 * its first sharer; it counts one more share and points at this thread.
 * Callers run it after the prompt is accepted and ignore its failure.
 */
export async function collectMessageLinks(input: {
  projectId: string;
  sessionId: string;
  spaceId: string | null;
  visibility: string;
  userId: string;
  text: string;
}): Promise<void> {
  if (!input.spaceId || input.visibility !== 'project') return;
  // Sorted: two concurrent upserts lock the same rows in the same order (no deadlock).
  const urls = extractMessageLinks(input.text).sort();
  if (urls.length === 0 || !(await findLiveChannel(input.projectId, input.spaceId))) return;
  const t = projectSpaceLinks;
  await db
    .insert(t)
    .values(
      urls.map((url) => ({
        projectId: input.projectId,
        spaceId: input.spaceId!,
        url,
        createdBy: input.userId,
        pinned: false,
        source: 'message' as const,
        sessionId: input.sessionId,
      })),
    )
    .onConflictDoUpdate({
      target: [t.spaceId, t.url],
      set: {
        // An "Add link" row counts its first share in a thread as 1, not 2.
        shareCount: sql`case when ${t.source} = 'manual' and ${t.sessionId} is null then 1 else ${t.shareCount} + 1 end`,
        lastSharedAt: sql`now()`,
        sessionId: sql`excluded.session_id`,
      },
    });
  await pruneSharedLinks(input.spaceId);
}

/**
 * `collectMessageLinks` after a person's prompt is accepted, without waiting
 * and never failing the send: only with `project_channels` on and a person
 * (`userId` null for an agent, a trigger or a service account).
 */
export function collectMessageLinksInBackground(
  input: Omit<Parameters<typeof collectMessageLinks>[0], 'userId'> & { userId: string | null; projectMetadata: unknown },
): void {
  const { userId, projectMetadata, ...rest } = input;
  if (!userId || !rest.spaceId || !resolveFeatureFlag(projectMetadata, 'project_channels')) return;
  // After the handler returns its response: the extraction never delays the send.
  setImmediate(() => {
    collectMessageLinks({ ...rest, userId }).catch((err) =>
      logger.warn('[spaces] collecting message links failed', {
        sessionId: rest.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
}

/** Drop the least recently shared unpinned links past `SPACE_SHARED_LINKS_MAX`. */
async function pruneSharedLinks(spaceId: string): Promise<void> {
  const stale = db
    .select({ id: projectSpaceLinks.linkId })
    .from(projectSpaceLinks)
    .where(and(eq(projectSpaceLinks.spaceId, spaceId), eq(projectSpaceLinks.pinned, false)))
    .orderBy(desc(projectSpaceLinks.lastSharedAt), desc(projectSpaceLinks.linkId))
    .offset(SPACE_SHARED_LINKS_MAX);
  await db.delete(projectSpaceLinks).where(inArray(projectSpaceLinks.linkId, stale));
}
