// What a Teams channel binding is called: `Team › Channel`.
//
// A binding is one channel thread (`19:…@thread.tacv2;messageid=…`). Its
// message carries the team's id but rarely the team's or the channel's name,
// so every thread read as "General", in every channel of every team. The names
// come from the Bot Connector (`/v3/teams/{id}`, `/v3/teams/{id}/conversations`),
// cached per team, and are stored on the binding.
import { chatChannelBindings } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../../../lib/logger';
import { db } from '../../../lib/db';
import { getTeamsTeam, listTeamsTeamChannels } from '../teams-api';
import { ensureTeamsConversationBinding } from './binding';
import type { TeamsActivity } from './types';
import {
  conversationScope,
  describeTeamsConversation,
  isTeamsChannelThreadId,
  TEAMS_GENERAL_CHANNEL,
  teamsChannelRoot,
} from './util';

// A team's name changes rarely, and an id that is not a team never becomes
// one: the bindings list asks about every unnamed thread's channel, and a
// thread outside a General channel is never a team. Both are kept an hour. A
// team's channel list is read again sooner, so a new channel is named within
// minutes.
const TEAM_TTL_MS = 60 * 60 * 1000;
const CHANNELS_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;

interface Entry<T> {
  until: number;
  value: Promise<T | null>;
}

// replica-local: per-replica memo of Teams team reads. A miss only costs one
// extra Graph call per replica and the resolved label lands in the DB binding
// row, so replicas converge; a shared store buys nothing until the calls cost.
const teamReads = new Map<string, Entry<{ id: string; name: string }>>();
// replica-local: same contract as teamReads above, for channel lists.
const channelReads = new Map<string, Entry<Array<{ id: string; name: string | null }>>>();

export function resetTeamsChannelLabelsForTest(): void {
  teamReads.clear();
  channelReads.clear();
}

function cached<T>(
  cache: Map<string, Entry<T>>,
  key: string,
  ttlMs: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.value;
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  const value = load().catch(() => null);
  cache.set(key, { until: now + ttlMs, value });
  return value;
}

/**
 * `Team › Channel` for channel `channelId` of team `teamId`, read from the Bot
 * Connector. The General channel's id is the team's id. Null when Teams does
 * not answer.
 */
export async function resolveTeamsChannelName(input: {
  serviceUrl: string;
  teamId: string;
  channelId: string;
  projectId: string;
}): Promise<string | null> {
  const key = `${input.projectId}:${input.teamId}`;
  const team = await cached(teamReads, key, TEAM_TTL_MS, () =>
    getTeamsTeam(input.serviceUrl, input.teamId, input.projectId),
  );
  if (!team) return null;
  if (input.channelId === team.id) return `${team.name} › ${TEAMS_GENERAL_CHANNEL}`;
  const channels = await cached(channelReads, key, CHANNELS_TTL_MS, () =>
    listTeamsTeamChannels(input.serviceUrl, team.id, input.projectId),
  );
  const channel = channels?.find((c) => c.id === input.channelId)?.name;
  return channel ? `${team.name} › ${channel}` : null;
}

/**
 * Names a channel thread's binding `Team › Channel` from the Bot Connector,
 * when the message itself does not say the team. Runs after the binding
 * exists. Never throws.
 */
export async function labelTeamsChannelBinding(input: {
  projectId: string;
  tenantId: string;
  conversationId: string;
  activity: Pick<TeamsActivity, 'serviceUrl' | 'conversation' | 'channelData'>;
}): Promise<void> {
  const { activity } = input;
  try {
    if (conversationScope(activity) !== 'channel' || describeTeamsConversation(activity).channelName) return;
    const teamId = activity.channelData?.team?.id;
    const channelId = teamsChannelRoot(activity);
    if (!teamId || !channelId || !activity.serviceUrl) return;
    const channelName = await resolveTeamsChannelName({
      serviceUrl: activity.serviceUrl,
      teamId,
      channelId,
      projectId: input.projectId,
    });
    if (!channelName) return;
    await ensureTeamsConversationBinding({
      projectId: input.projectId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      channelName,
      channelType: 'channel',
    });
  } catch (err) {
    logger.warn('[teams] channel label failed (non-fatal)', { error: (err as Error)?.message });
  }
}

/**
 * Should `GET /channels/bindings` ask Teams to name this row? A channel thread
 * whose name does not say its team yet.
 */
export function needsTeamsNameBackfill(binding: {
  platform: string;
  channelId: string;
  channelName: string | null;
}): boolean {
  return (
    binding.platform === 'teams' && isTeamsChannelThreadId(binding.channelId) && !binding.channelName?.includes(' › ')
  );
}

/**
 * Names a stored channel thread on read, and stores the name. Only a thread
 * of a team's General channel can be named from the binding alone: that
 * channel's id is the team's id. A thread in another channel is named by its
 * next message. Never throws.
 */
export async function backfillTeamsBindingLabel(
  binding: { bindingId: string; channelId: string },
  projectId: string,
  serviceUrl: string,
): Promise<string | null> {
  try {
    const root = binding.channelId.split(';')[0] ?? binding.channelId;
    const channelName = await resolveTeamsChannelName({ serviceUrl, teamId: root, channelId: root, projectId });
    if (!channelName) return null;
    await db
      .update(chatChannelBindings)
      .set({ channelName, channelType: 'channel' })
      .where(eq(chatChannelBindings.bindingId, binding.bindingId));
    return channelName;
  } catch (err) {
    logger.warn('[teams] binding label lookup failed (non-fatal)', { error: (err as Error)?.message });
    return null;
  }
}
