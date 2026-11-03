/**
 * `/connect`: which Kortix project a Discord channel or DM uses, when more than
 * one could (a server installed in several projects, a person allowed in
 * several). The command answers at once with one button per project (`kd:`);
 * a press from a person the chosen project allows binds the channel
 * (`chat_channel_bindings`). Re-pointing a channel bound to another project
 * also needs that project to allow the presser.
 */
import { chatChannelBindings, chatInstalls, projects } from '@kortix/db';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../shared/db';
import { readChannelAccess } from '../core/channel-access';
import { clip } from './render';
import { discordGuildProjects } from './installs';
import { projectNames, projectsAllowing } from './routing';
import type { DiscordConversation } from './types';

/** `kd:<project id>`: 39 bytes. The press binds the channel it is in; the token names no channel. */
const PROJECT_PRESS = /^kd:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const isProjectPress = (data: string) => data.startsWith('kd:');

/** The project a `kd:` token names; '' when it is not one. */
export function parseProjectPress(data: string): string {
  return PROJECT_PRESS.exec(data)?.[1] ?? '';
}

export const projectPressData = (projectId: string) => `kd:${projectId}`;

/**
 * The webhook's immediate answer to `/connect`: one button per project that
 * can answer here, only the sender sees it. In a server: every project with
 * the server installed. In a DM: every project that allows the sender.
 */
export async function connectReply(place: { guildId: string | null; userId: string }): Promise<{ content: string; components: unknown[] }> {
  const ids = place.guildId ? await discordGuildProjects(place.guildId) : (await projectsAllowing(place.userId)).map((p) => p.projectId);
  const named = (await projectNames(ids)).slice(0, 25);
  if (!named.length) {
    return {
      content: place.guildId
        ? 'This server is not connected to a Kortix project. A project admin connects it under Customize → Connectors → Channels → Discord.'
        : 'No Kortix project allows your Discord account yet. Ask a project admin to allow your Discord user id under Customize → Connectors → Channels → Discord.',
      components: [],
    };
  }
  const buttons = named.map((p) => ({ type: 2, style: 2, label: clip(p.name, 80), custom_id: projectPressData(p.projectId) }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return { content: `Which Kortix project should this ${place.guildId ? 'channel' : 'conversation'} use?`, components: rows };
}

/**
 * Bind the conversation's settings channel to `projectId`, whose install is the
 * conversation's guild (the webhook checked it). False: another project holds
 * the channel and does not allow `userId`.
 */
export async function bindDiscordChannel(conversation: DiscordConversation, projectId: string, userId: string): Promise<boolean> {
  const channelId = conversation.settingsId;
  const held = await db
    .select({ projectId: chatChannelBindings.projectId, metadata: projects.metadata })
    .from(chatChannelBindings)
    .innerJoin(projects, and(eq(projects.projectId, chatChannelBindings.projectId), eq(projects.status, 'active')))
    .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId), ne(chatChannelBindings.projectId, projectId)));
  if (held.some((row) => !readChannelAccess(row.metadata, 'discord').allowedUserIds.includes(userId))) return false;
  await db.transaction(async (tx) => {
    const [install] = await tx
      .select({ id: chatInstalls.installId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.workspaceId, conversation.guildId), eq(chatInstalls.projectId, projectId)))
      .limit(1);
    if (!install) return;
    // A DM has one row whatever guild it sits under; a guild channel has one in its guild.
    await tx.delete(chatChannelBindings).where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId)));
    await tx.insert(chatChannelBindings).values({
      platform: 'discord',
      workspaceId: conversation.guildId,
      channelId,
      projectId,
      channelName: conversation.direct ? 'direct message' : conversation.channelName ? `#${conversation.channelName}` : null,
      channelType: conversation.direct ? 'dm' : 'channel',
    });
  });
  return true;
}

/**
 * The first project a conversation runs, kept: when a second project installs
 * the server (or allows the person of a DM), the channels already in use stay
 * with the first. Never takes a channel another project holds.
 */
export async function claimDiscordChannel(conversation: DiscordConversation, projectId: string): Promise<void> {
  if (conversation.direct) {
    // A DM's row may sit under any guild: one row at most.
    const [any] = await db
      .select({ id: chatChannelBindings.bindingId })
      .from(chatChannelBindings)
      .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, conversation.settingsId)))
      .limit(1);
    if (any) return;
  }
  await db
    .insert(chatChannelBindings)
    .values({
      platform: 'discord',
      workspaceId: conversation.guildId,
      channelId: conversation.settingsId,
      projectId,
      channelName: conversation.direct ? 'direct message' : conversation.channelName ? `#${conversation.channelName}` : null,
      channelType: conversation.direct ? 'dm' : 'channel',
    })
    .onConflictDoNothing({ target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId] });
}
