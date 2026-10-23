/**
 * Channels onboarding (spec section 14, D8): the member intro seen once, the
 * `#general` "Get started" block, and the "turned on again" line. Marks live in
 * `kortix.project_user_marks`; the routes are in `routes/project-spaces.ts`.
 */
import type { ChannelsOnboarding, ChannelsOnboardingMark, SpaceGeneralNotice } from '@kortix/api-contract';
import { memoryLayers, memoryPageVersions, projectSpaces, projectUserMarks, projects } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import { accountMemberUserIds } from '../../iam/membership-read';
import { db } from '../../shared/db';
import { isPlainObject } from '../../shared/json';
import { metadataMergeSubtree } from './metadata-merge';

const NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

export async function addChannelsMark(projectId: string, userId: string, mark: ChannelsOnboardingMark): Promise<void> {
  await db.insert(projectUserMarks).values({ projectId, userId, mark }).onConflictDoNothing();
}

/** A row is done when its mark is present or its fact is true. */
export async function channelsOnboarding(projectId: string, userId: string): Promise<ChannelsOnboarding> {
  const [marks, channel, remember, dm] = await Promise.all([
    db
      .select({ mark: projectUserMarks.mark })
      .from(projectUserMarks)
      .where(and(eq(projectUserMarks.projectId, projectId), eq(projectUserMarks.userId, userId))),
    // A channel the caller created (`#general` has no creator; archived ones count).
    db
      .select({ id: projectSpaces.spaceId })
      .from(projectSpaces)
      .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'channel'), eq(projectSpaces.createdBy, userId), eq(projectSpaces.isDefault, false)))
      .limit(1),
    // A page change in `#general`'s layer by the caller, or by an agent on the caller's behalf.
    db
      .select({ id: memoryPageVersions.versionId })
      .from(memoryPageVersions)
      .innerJoin(memoryLayers, eq(memoryLayers.layerId, memoryPageVersions.layerId))
      .innerJoin(projectSpaces, eq(projectSpaces.spaceId, memoryLayers.spaceId))
      .where(
        and(
          eq(projectSpaces.projectId, projectId),
          eq(projectSpaces.isDefault, true),
          or(eq(memoryPageVersions.authorUserId, userId), eq(memoryPageVersions.onBehalfUserId, userId)),
        ),
      )
      .limit(1),
    db
      .select({ id: projectSpaces.spaceId })
      .from(projectSpaces)
      .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'dm'), eq(projectSpaces.dmUserId, userId)))
      .limit(1),
  ]);
  const has = new Set(marks.map((row) => row.mark));
  const createChannel = has.has('get_started.channel') || channel.length > 0;
  const rememberDone = has.has('get_started.remember') || remember.length > 0;
  const openDm = has.has('get_started.dm') || dm.length > 0;
  return {
    intro_seen: has.has('channels_intro'),
    get_started: {
      visible: !has.has('get_started.dismissed') && !(createChannel && rememberDone && openDm),
      create_channel: createChannel,
      remember: rememberDone,
      open_dm: openDm,
    },
  };
}

/**
 * Channels turned on again: `#general` shows the line for 7 days, and no
 * member sees the intro (every account member gets `channels_intro`).
 */
export async function recordChannelsReenabled(projectId: string, accountId: string, filed: number): Promise<void> {
  await db
    .update(projects)
    .set({ metadata: metadataMergeSubtree('channels', { reenabled_at: new Date().toISOString(), reenabled_count: filed }) })
    .where(eq(projects.projectId, projectId));
  const members = await accountMemberUserIds(accountId);
  if (members.length === 0) return;
  await db
    .insert(projectUserMarks)
    .values(members.map(({ userId }) => ({ projectId, userId, mark: 'channels_intro' })))
    .onConflictDoNothing();
}

/** The "turned on again" line, from `metadata.channels`: 7 days, and only when it filed a session. */
export function generalNotice(metadata: unknown, now = Date.now()): SpaceGeneralNotice | undefined {
  const channels = isPlainObject(metadata) && isPlainObject(metadata.channels) ? metadata.channels : {};
  const at = typeof channels.reenabled_at === 'string' ? Date.parse(channels.reenabled_at) : Number.NaN;
  const count = channels.reenabled_count;
  if (!Number.isFinite(at) || now - at > NOTICE_MS || !Number.isInteger(count) || (count as number) < 1) return undefined;
  return { kind: 'reenabled', at: new Date(at).toISOString(), count: count as number };
}
