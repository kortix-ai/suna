/**
 * Channels onboarding: the member intro seen once, the
 * `#general` "Get started" block, and the "turned on again" line. Marks live in
 * `kortix.project_user_marks`; the routes are in `routes/project-spaces.ts`.
 */
import type { ChannelsOnboarding, ChannelsOnboardingMark, SpaceGeneralNotice } from '@kortix/api-contract';
import { projectSpaces, projectUserMarks, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isPlainObject } from '../../shared/json';
import { loadProjectRosterIds } from './project-access-view';

const NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
/** Marks per INSERT: 3 bind parameters each, far below the 65,535 limit. */
const MARK_BATCH = 5_000;

export async function addChannelsMark(projectId: string, userId: string, mark: ChannelsOnboardingMark): Promise<void> {
  await db.insert(projectUserMarks).values({ projectId, userId, mark }).onConflictDoNothing();
}

/** A row is done when its mark is present or its fact is true. */
export async function channelsOnboarding(projectId: string, userId: string): Promise<ChannelsOnboarding> {
  // "Tell #general something": the memory routes set `get_started.remember` when the caller writes `#general`'s memory.
  const [marks, channel, dm] = await Promise.all([
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
    db
      .select({ id: projectSpaces.spaceId })
      .from(projectSpaces)
      .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'dm'), eq(projectSpaces.dmUserId, userId)))
      .limit(1),
  ]);
  const has = new Set(marks.map((row) => row.mark));
  const createChannel = has.has('get_started.channel') || channel.length > 0;
  const rememberDone = has.has('get_started.remember');
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

/** The "turned on again" line, from `metadata.channels`: 7 days, and only when it filed a session. */
export function generalNotice(metadata: unknown, now = Date.now()): SpaceGeneralNotice | undefined {
  const channels = isPlainObject(metadata) && isPlainObject(metadata.channels) ? metadata.channels : {};
  const at = typeof channels.reenabled_at === 'string' ? Date.parse(channels.reenabled_at) : Number.NaN;
  const count = channels.reenabled_count;
  if (!Number.isFinite(at) || now - at > NOTICE_MS || !Number.isInteger(count) || (count as number) < 1) return undefined;
  return { kind: 'reenabled', at: new Date(at).toISOString(), count: count as number };
}
