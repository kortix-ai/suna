/**
 * Which project a Discord message or interaction belongs to.
 *
 *   a thread with a session   → that session's project
 *   a bound channel           → the channel's project (`chat_channel_bindings`)
 *   a server in one project   → that project
 *   a server in several       → 'ambiguous': `/connect` picks one for the channel
 *   a direct message          → the DM's bound project, else the one project
 *                               that allows the sender, else 'ambiguous' or 'none'
 *
 * A guild channel's settings row (agent, model, project) is the channel's: a
 * thread inherits its parent channel's. A DM's row sits under the guild of the
 * project it is bound to, so `ChannelTarget.workspaceId` is always a guild id
 * (`chat_installs.workspace_id`, the access scope). Reads only, so the
 * interactions webhook can call it; the conversation writes the binding
 * (settings.ts `ensureChatBinding`).
 */
import { chatChannelBindings, chatInstalls, projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../shared/db';
import { readChannelAccess } from '../core/channel-access';
import { findChatThread } from '../core/threads';
import { discordGuildProjects } from './installs';

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
        eq(chatInstalls.workspaceId, chatChannelBindings.workspaceId),
        eq(chatInstalls.projectId, chatChannelBindings.projectId),
      ),
    )
    .innerJoin(projects, and(eq(projects.projectId, chatChannelBindings.projectId), eq(projects.status, 'active')))
    .where(
      and(
        eq(chatChannelBindings.platform, 'discord'),
        eq(chatChannelBindings.workspaceId, guildId),
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

/** A DM: its bound project, else the projects whose Discord allow-list holds the sender. */
async function resolveDirect(place: DiscordPlace): Promise<DiscordRoute> {
  const conversation = { platform: 'discord', threadId: place.channelId };
  const rows = await db
    .select({ projectId: chatChannelBindings.projectId, guildId: chatChannelBindings.workspaceId })
    .from(chatChannelBindings)
    .innerJoin(
      chatInstalls,
      and(
        eq(chatInstalls.platform, 'discord'),
        eq(chatInstalls.workspaceId, chatChannelBindings.workspaceId),
        eq(chatInstalls.projectId, chatChannelBindings.projectId),
      ),
    )
    .innerJoin(projects, and(eq(projects.projectId, chatChannelBindings.projectId), eq(projects.status, 'active')))
    .where(and(eq(chatChannelBindings.platform, conversation.platform), eq(chatChannelBindings.channelId, place.channelId)));
  if (rows.length === 1) return { kind: 'project', projectId: rows[0]!.projectId!, guildId: rows[0]!.guildId };
  const allowing = place.userId ? await projectsAllowing(place.userId) : [];
  if (allowing.length === 1) return { kind: 'project', projectId: allowing[0]!.projectId, guildId: allowing[0]!.guildId };
  return allowing.length ? { kind: 'ambiguous', projectIds: allowing.map((p) => p.projectId), guildId: null } : { kind: 'none' };
}

/** The active projects with a Discord server whose allow-list holds `userId`. */
// ponytail: reads every Discord install's project metadata, once per DM that no binding routes.
// Upgrade: a jsonb containment index on metadata->'discord'->'allowedUserIds'.
export async function projectsAllowing(userId: string): Promise<Array<{ projectId: string; guildId: string }>> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId, guildId: chatInstalls.workspaceId, metadata: projects.metadata })
    .from(chatInstalls)
    .innerJoin(projects, and(eq(projects.projectId, chatInstalls.projectId), eq(projects.status, 'active')))
    .where(eq(chatInstalls.platform, 'discord'));
  return rows
    .filter((r) => readChannelAccess(r.metadata, 'discord').allowedUserIds.includes(userId))
    .map(({ projectId, guildId }) => ({ projectId, guildId }));
}

/** The names of the projects a picker offers, in the order given. */
export async function projectNames(projectIds: string[]): Promise<Array<{ projectId: string; name: string }>> {
  if (!projectIds.length) return [];
  const rows = await db
    .select({ projectId: projects.projectId, name: projects.name })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));
  return projectIds.flatMap((id) => {
    const row = rows.find((r) => r.projectId === id);
    return row ? [{ projectId: id, name: row.name }] : [];
  });
}
