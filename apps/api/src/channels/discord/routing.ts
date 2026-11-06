/**
 * Which project a Discord message or interaction belongs to.
 *
 *   a thread with a session   → that session's project
 *   a bound channel           → the channel's project (`chat_channel_bindings`)
 *   a server in one project   → that project
 *   a server in several       → 'ambiguous': `/connect` picks one for the channel
 *   a direct message          → the DM's bound project while it still allows the
 *                               sender, else the one project that allows them,
 *                               else 'ambiguous' or 'none'
 *
 * A guild channel's settings row (agent, model, project) is the channel's: a
 * thread inherits its parent channel's. A DM's row sits under the guild of the
 * project it is bound to, so `ChannelTarget.workspaceId` is always a guild id
 * (`chat_installs.workspace_id`, the access scope). Reads only, so the
 * interactions webhook can call it; the conversation writes the binding
 * (settings.ts `ensureChatBinding`).
 */
import { chatChannelBindings, chatInstalls } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { readChannelAccess } from '../core/channel-access';
import { findChatThread } from '../core/threads';
import { discordGuildProjects } from './installs';
import { projectsView } from '../../workspaces/rows';

export type DiscordRoute =
  /** `guildId`: the project's install, the conversation's workspace. */
  | { kind: 'project'; projectId: string; guildId: string }
  | { kind: 'ambiguous'; projectIds: string[]; guildId: string | null }
  | { kind: 'none' };

/** A conversation's place: the guild (absent in a DM), its channel, and the thread it is in, if any. */
export interface DiscordPlace {
  guildId: string | null;
  /** The settings channel: a thread's parent, else the channel itself (a DM channel in a DM). */
  channelId: string;
  /** The thread the message is in. */
  threadId?: string;
  /** The sender, for a DM. */
  userId?: string;
}

/** The project of a bound channel row whose project still has the guild installed. */
async function boundProject(guildId: string, channelId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .innerJoin(
      chatInstalls,
      and(
        eq(chatInstalls.platform, 'discord'),
        eq(chatInstalls.platformTeamId, chatChannelBindings.platformTeamId),
        eq(chatInstalls.projectId, chatChannelBindings.projectId),
      ),
    )
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatChannelBindings.projectId), eq(projectsView.status, 'active')))
    .where(
      and(
        eq(chatChannelBindings.platform, 'discord'),
        eq(chatChannelBindings.platformTeamId, guildId),
        eq(chatChannelBindings.channelId, channelId),
      ),
    )
    .limit(1);
  return row?.projectId ?? null;
}

export async function resolveDiscordRoute(place: DiscordPlace): Promise<DiscordRoute> {
  return place.guildId ? resolveGuild({ ...place, guildId: place.guildId }) : resolveDirect(place);
}

async function resolveGuild(place: DiscordPlace & { guildId: string }): Promise<DiscordRoute> {
  const { guildId } = place;
  const installs = await discordGuildProjects(guildId);
  if (place.threadId) {
    // A thread of a project that left the server (or was deleted) routes as a new conversation.
    const thread = await findChatThread({ platform: 'discord', workspaceId: guildId, threadId: place.threadId });
    if (thread && installs.includes(thread.projectId)) return { kind: 'project', projectId: thread.projectId, guildId };
  }
  const bound = await boundProject(guildId, place.channelId);
  if (bound) return { kind: 'project', projectId: bound, guildId };
  if (installs.length === 1) return { kind: 'project', projectId: installs[0]!, guildId };
  return installs.length ? { kind: 'ambiguous', projectIds: installs, guildId } : { kind: 'none' };
}

/**
 * A DM: its bound project, else the projects whose Discord allow-list holds
 * the sender. A DM has one person: a bound project that removed them from its
 * list holds the DM no more.
 */
async function resolveDirect(place: DiscordPlace): Promise<DiscordRoute> {
  const conversation = { platform: 'discord', threadId: place.channelId };
  const bound = await db
    .select({ projectId: chatChannelBindings.projectId, guildId: chatChannelBindings.platformTeamId, metadata: projectsView.metadata })
    .from(chatChannelBindings)
    .innerJoin(
      chatInstalls,
      and(
        eq(chatInstalls.platform, 'discord'),
        eq(chatInstalls.platformTeamId, chatChannelBindings.platformTeamId),
        eq(chatInstalls.projectId, chatChannelBindings.projectId),
      ),
    )
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatChannelBindings.projectId), eq(projectsView.status, 'active')))
    .where(and(eq(chatChannelBindings.platform, conversation.platform), eq(chatChannelBindings.channelId, place.channelId)));
  const rows = place.userId ? bound.filter((r) => readChannelAccess(r.metadata, 'discord').allowedUserIds.includes(place.userId!)) : bound;
  if (rows.length === 1) return { kind: 'project', projectId: rows[0]!.projectId!, guildId: rows[0]!.guildId };
  const allowing = place.userId ? await projectsAllowing(place.userId) : [];
  if (allowing.length === 1) return { kind: 'project', projectId: allowing[0]!.projectId, guildId: allowing[0]!.guildId };
  return allowing.length ? { kind: 'ambiguous', projectIds: allowing.map((p) => p.projectId), guildId: null } : { kind: 'none' };
}

/** The active projects with a Discord server whose allow-list holds `userId`. */
// ponytail: the containment test runs on every Discord install's project row, inside Discord's
// 3-second interaction window. Upgrade at ~10k installs: a GIN index on metadata->'discord'->'allowedUserIds'.
export async function projectsAllowing(userId: string): Promise<Array<{ projectId: string; guildId: string }>> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId, guildId: chatInstalls.platformTeamId, metadata: projectsView.metadata })
    .from(chatInstalls)
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatInstalls.projectId), eq(projectsView.status, 'active')))
    .where(
      and(
        eq(chatInstalls.platform, 'discord'),
        // Only the rows that can hold the id travel; `readChannelAccess` below keeps the exact rule.
        sql`${projectsView.metadata} -> 'discord' -> 'allowedUserIds' @> ${JSON.stringify([userId])}::jsonb`,
      ),
    );
  return rows
    .filter((r) => readChannelAccess(r.metadata, 'discord').allowedUserIds.includes(userId))
    .map(({ projectId, guildId }) => ({ projectId, guildId }));
}

/** The names of the projects a picker offers, in the order given. */
export async function projectNames(projectIds: string[]): Promise<Array<{ projectId: string; name: string }>> {
  if (!projectIds.length) return [];
  const rows = await db
    .select({ projectId: projectsView.projectId, name: projectsView.name })
    .from(projectsView)
    .where(inArray(projectsView.projectId, projectIds));
  return projectIds.flatMap((id) => {
    const row = rows.find((r) => r.projectId === id);
    return row ? [{ projectId: id, name: row.name }] : [];
  });
}
