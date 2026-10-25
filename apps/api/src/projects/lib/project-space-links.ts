/**
 * A channel's links (`kortix.project_space_links`), its Links tab: the links
 * members added ("Add link") and the links people shared in its threads
 * (collected). Every link starts unpinned; a member pins one, and unpinning
 * never removes it. Agents read the pinned ones (`drives/service.ts`). The routes in `routes/project-spaces.ts`
 * check the channel first (`findLiveChannel`); these functions take its id as
 * already checked.
 */
import type { SpaceLink, SpaceLinkCreateInput } from '@kortix/api-contract';
import { projectSpaceLinks } from '@kortix/db';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { enqueueLinkUnfurls } from './link-unfurl';
import { extractMessageLinks } from './message-links';
import { findLiveChannel } from './project-spaces';
import { isSpaceMember } from './project-space-members';
import { resolveSessionOwnerIdentities } from './user-identity';

type LinkRow = typeof projectSpaceLinks.$inferSelect;

/** The most pinned links one channel holds; pinning past it gets 409 `link_limit`. */
export const SPACE_LINKS_MAX = 200;
/** The most links one channel holds from "Add link"; one more add gets 409 `link_limit`. */
export const SPACE_ADDED_LINKS_MAX = 200;
/** The most unpinned collected links one channel keeps; the least recently shared go first. Added links are never pruned. */
const SPACE_SHARED_LINKS_MAX = 500;

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
    last_shared_at: row.lastSharedAt.toISOString(),
    display_title: row.title?.trim() || row.fetchedTitle || linkPathTitle(row.url),
    site_name: row.siteName,
    icon_url: row.iconUrl,
  };
}

/** The URL's path and query, decoded, without the outer slashes; the host for a bare host. */
export function linkPathTitle(url: string): string {
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // `+` means a space in a query only; in a path it is a plus (`wiki/C++`).
  const text = (decode(parsed.pathname) + decode(parsed.search.replace(/\+/g, ' ')))
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || parsed.hostname.replace(/^www\./, '');
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
 * Add a link, unpinned, recorded as added by the caller. The URL is stored as
 * the URL parser serializes it (the schema already checked it parses as
 * http(s)), so spaces and the like reach the README and the `href` encoded. A
 * URL the channel already holds is not duplicated: that row takes the new
 * title, keeps its pin and its first sharer, and moves to the top of the list.
 * `link_limit` at `SPACE_ADDED_LINKS_MAX` added links.
 */
export async function addSpaceLink(
  projectId: string,
  spaceId: string,
  accountId: string,
  viewer: LinkViewer,
  input: SpaceLinkCreateInput,
): Promise<SpaceLink | 'link_limit'> {
  // ponytail: count-then-insert, so two concurrent adds can pass 200 by one each; a per-space lock if that matters.
  if ((await countAddedLinks(spaceId)) >= SPACE_ADDED_LINKS_MAX) return 'link_limit';
  const url = new URL(input.url).href;
  const t = projectSpaceLinks;
  const [row] = await db
    .insert(t)
    // `pinned` is set here: the column's default (true) dates from when "Add link" pinned.
    .values({ projectId, spaceId, url, title: input.title || null, createdBy: viewer.userId, pinned: false })
    .onConflictDoUpdate({
      target: [t.spaceId, t.url],
      set: { title: sql`coalesce(excluded.title, ${t.title})`, lastSharedAt: sql`now()` },
    })
    .returning();
  await enqueueLinkUnfurls([row!]);
  const [link] = await serializeLinks([row!], viewer, accountId);
  return link!;
}

/**
 * Pin or unpin a link; any member who sees the channel may. Unpinning only
 * clears the pin: the link stays listed (removing it is `deleteSpaceLink`).
 * `link_limit` at `SPACE_LINKS_MAX` pinned.
 */
export async function pinSpaceLink(
  spaceId: string,
  linkId: string,
  accountId: string,
  viewer: LinkViewer,
  pinned: boolean,
): Promise<SpaceLink | 'not_found' | 'link_limit'> {
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

async function countAddedLinks(spaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(projectSpaceLinks)
    .where(and(eq(projectSpaceLinks.spaceId, spaceId), eq(projectSpaceLinks.source, 'manual')));
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
 * thread every member of the channel sees (`project` visibility) of a live
 * channel, from a member when the channel is private: a DM or a private
 * thread shares nothing. An address the channel holds keeps
 * its first sharer; it counts one more share and points at this thread.
 * Each link without a fresh title is queued for the background fetch (`link-unfurl.ts`).
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
  if (urls.length === 0) return;
  const channel = await findLiveChannel(input.projectId, input.spaceId);
  // A private channel takes links only from its members: a sender who lost
  // access between the send and this write adds nothing.
  if (!channel || (channel.visibility === 'private' && !(await isSpaceMember(channel, input.userId)))) return;
  const t = projectSpaceLinks;
  const rows = await db
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
        lastSharedAt: sql`now()`,
        sessionId: sql`excluded.session_id`,
      },
    })
    .returning({ linkId: t.linkId, fetchedAt: t.fetchedAt, fetchFailedAt: t.fetchFailedAt });
  await enqueueLinkUnfurls(rows);
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

/** Drop the least recently shared unpinned collected links past `SPACE_SHARED_LINKS_MAX`; an added link stays. */
async function pruneSharedLinks(spaceId: string): Promise<void> {
  const stale = db
    .select({ id: projectSpaceLinks.linkId })
    .from(projectSpaceLinks)
    .where(
      and(eq(projectSpaceLinks.spaceId, spaceId), eq(projectSpaceLinks.pinned, false), eq(projectSpaceLinks.source, 'message')),
    )
    .orderBy(desc(projectSpaceLinks.lastSharedAt), desc(projectSpaceLinks.linkId))
    .offset(SPACE_SHARED_LINKS_MAX);
  await db.delete(projectSpaceLinks).where(inArray(projectSpaceLinks.linkId, stale));
}
