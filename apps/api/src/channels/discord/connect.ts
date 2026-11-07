/**
 * `/connect`: which Kortix project a Discord channel or DM uses, when more than
 * one could (a server installed in several projects, a person allowed in
 * several). The command answers at once with one button per project (`kd:`);
 * a press from a person the chosen project allows binds the channel
 * (`chat_channel_bindings`). Re-pointing a channel bound to another project
 * also needs that project to allow the presser.
 */
import { chatChannelBindings, chatInstalls, chatThreads } from '@kortix/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { readChannelAccess } from '../core/channel-access';
import { clip } from './render';
import { discordGuildProjects } from './installs';
import { projectNames, projectsAllowing } from './routing';
import type { DiscordConversation } from './types';
import { projectsView } from '../../workspaces/rows';

/** `kd:<project id>`: 39 bytes. The press binds the channel it is in; the token names no channel. */
export const isProjectPress = (data: string) => data.startsWith('kd:');

/** The project a `kd:` token names; '' when it is not one. */
export function parseProjectPress(data: string): string {
  const projectId = isProjectPress(data) ? data.slice('kd:'.length) : '';
  return isUuid(projectId) ? projectId : '';
}

export const projectPressData = (projectId: string) => `kd:${projectId}`;

/**
 * The webhook's immediate answer to `/connect`: one button per project that
 * can answer here, only the sender sees it. In a server: every project with
 * the server installed. In a DM: every project that allows the sender.
 */
export async function connectReply(place: { guildId: string | null; userId: string }): Promise<{ content: string; components: unknown[] }> {
  // Only the projects that allow the caller: no one else learns which projects share the server.
  const allowing = (await projectsAllowing(place.userId)).map((p) => p.projectId);
  const ids = place.guildId ? (await discordGuildProjects(place.guildId)).filter((id) => allowing.includes(id)) : allowing;
  const named = (await projectNames(ids)).slice(0, 25);
  if (!named.length) {
    return {
      content: `No Kortix workspace here allows your Discord account yet. Ask a workspace admin to allow your Discord user ID ${place.userId} under Customize → Connectors → Channels → Discord.`,
      components: [],
    };
  }
  const buttons = named.map((p) => ({ type: 2, style: 2, label: clip(p.name, 80), custom_id: projectPressData(p.projectId) }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return { content: `Which Kortix workspace should this ${place.guildId ? 'channel' : 'conversation'} use?`, components: rows };
}

/**
 * Bind the conversation's settings channel to `projectId`, whose install is the
 * conversation's guild (the webhook checked it). False: another project holds
 * the channel and does not allow `userId`, or the project left the server
 * since the press.
 */
export async function bindDiscordChannel(conversation: DiscordConversation, projectId: string, userId: string): Promise<boolean> {
  const channelId = conversation.settingsId;
  // Only its person presses a button in their own DM: they move it wherever a project allows them.
  const held = conversation.direct
    ? []
    : await db
        .select({ projectId: chatChannelBindings.projectId, metadata: projectsView.metadata })
        .from(chatChannelBindings)
        .innerJoin(projectsView, and(eq(projectsView.projectId, chatChannelBindings.projectId), eq(projectsView.status, 'active')))
        .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId), ne(chatChannelBindings.projectId, projectId)));
  if (held.some((row) => !readChannelAccess(row.metadata, 'discord').allowedUserIds.includes(userId))) return false;
  return db.transaction(async (tx) => {
    const [install] = await tx
      .select({ id: chatInstalls.installId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.platformTeamId, conversation.guildId), eq(chatInstalls.projectId, projectId)))
      .limit(1);
    if (!install) return false;
    // A DM has one row whatever guild it sits under; a guild channel has one in its guild.
    await tx.delete(chatChannelBindings).where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId)));
    // A conversation that is the channel itself (a DM, a channel without threads) leaves its old project's session.
    await tx
      .delete(chatThreads)
      .where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.threadId, channelId), ne(chatThreads.projectId, projectId)));
    await tx.insert(chatChannelBindings).values({
      platform: 'discord',
      platformTeamId: conversation.guildId,
      channelId,
      projectId,
      channelName: conversation.direct ? 'direct message' : conversation.channelName ? `#${conversation.channelName}` : null,
      channelType: conversation.direct ? 'dm' : 'channel',
    });
    return true;
  });
}

/**
 * The first project a conversation runs, kept: when a second project installs
 * the server (or allows the person of a DM), the channels already in use stay
 * with the first. Never takes a channel another project holds, except a DM
 * whose project removed its one person (`senderId`) from its list. A DM is
 * named after its person (`senderName`), as the Channels page lists it.
 */
export async function claimDiscordChannel(conversation: DiscordConversation, projectId: string, senderId: string, senderName?: string): Promise<void> {
  if (conversation.direct) {
    // A DM's row may sit under any guild: one row at most.
    const rows = await db
      .select({ id: chatChannelBindings.bindingId, projectId: chatChannelBindings.projectId, metadata: projectsView.metadata })
      .from(chatChannelBindings)
      .leftJoin(projectsView, eq(projectsView.projectId, chatChannelBindings.projectId))
      .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, conversation.settingsId)));
    const stale = rows.filter((r) => r.projectId !== projectId && !readChannelAccess(r.metadata, 'discord').allowedUserIds.includes(senderId));
    if (stale.length) await db.delete(chatChannelBindings).where(inArray(chatChannelBindings.bindingId, stale.map((r) => r.id)));
    if (rows.length > stale.length) return;
  }
  await db
    .insert(chatChannelBindings)
    .values({
      platform: 'discord',
      platformTeamId: conversation.guildId,
      channelId: conversation.settingsId,
      projectId,
      channelName: conversation.direct ? clip(senderName || 'direct message', 100) : conversation.channelName ? `#${conversation.channelName}` : null,
      channelType: conversation.direct ? 'dm' : 'channel',
    })
    .onConflictDoNothing({ target: [chatChannelBindings.platform, chatChannelBindings.platformTeamId, chatChannelBindings.channelId] });
}
