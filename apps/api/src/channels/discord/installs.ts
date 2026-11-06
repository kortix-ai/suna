/**
 * Discord install: one Discord server (guild) per project, through the Kortix
 * Discord application, like one Slack workspace per project. `chat_installs`
 * records the guild id; one guild may be installed in several projects, and
 * each channel goes to one of them (`chat_channel_bindings`, discord/routing.ts).
 * The bot token is the application's (config), never a project secret. The
 * guild's name is a project secret, as Slack keeps its team's. Allowed senders
 * and access requests are `projects.metadata.discord`
 * (channels/core/channel-access.ts), scoped to the guild id.
 */
import { chatChannelBindings, chatInstalls, chatThreads } from '@kortix/db';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { and, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type ChannelAccessEntry,
  type ChannelAccessRequester,
  cleanName,
  clearChannelAccessRequests,
  readChannelAccess,
} from '../core/channel-access';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';
import { discordCall, discordConfigured } from './api';
import { projectsView } from '../../workspaces/rows';

export const DISCORD_GUILD_NAME = 'DISCORD_GUILD_NAME';

export const DISCORD_USER_ID = CHANNELS.discord.access.userId;

/** A sender's id and cleaned names (the access port's `requester`). Null: no valid Discord user id. */
export function discordRequester(from: unknown): ChannelAccessRequester | null {
  const user = (from ?? {}) as { id?: unknown; username?: unknown; global_name?: unknown };
  const id = typeof user.id === 'string' ? user.id : '';
  if (!DISCORD_USER_ID.test(id)) return null;
  // A Discord user has a unique username and an optional display name; there is no last name.
  return { id, username: cleanName(user.username, 32), first_name: cleanName(user.global_name, 64), last_name: null };
}

export interface DiscordInstall {
  guildId: string;
  guildName: string | null;
  allowedUserIds: string[];
  /** Requests still waiting: not allowed, under 30 days old, newest first. */
  accessRequests: ChannelAccessEntry[];
}

/** The project's chats' `/model` and `/agent` choices and its channel bindings. */
function deleteDiscordBindings(projectId: string) {
  return db
    .delete(chatChannelBindings)
    .where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.projectId, projectId)));
}

/** Install the guild in the project. Another guild replaces the project's: its requests, bindings and settings go. */
export async function saveDiscordInstall(input: { projectId: string; guildId: string; guildName: string | null }): Promise<{
  replacedGuildId: string | null;
}> {
  const [previous] = await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.projectId, input.projectId)))
    .returning({ guildId: chatInstalls.platformTeamId });
  await db
    .insert(chatInstalls)
    .values({ platform: 'discord', platformTeamId: input.guildId, projectId: input.projectId })
    .onConflictDoNothing();
  const replaced = previous && previous.guildId !== input.guildId ? previous.guildId : null;
  if (replaced) {
    // Requests came from the old server's members; its channels, threads and DMs were the old server's.
    await clearChannelAccessRequests('discord', input.projectId);
    await deleteDiscordBindings(input.projectId);
    await db.delete(chatThreads).where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.projectId, input.projectId)));
  }
  await upsertSecret(input.projectId, DISCORD_GUILD_NAME, input.guildName ?? '');
  return { replacedGuildId: replaced };
}

/** Null when the project has no Discord server, or is deleted (its tombstone keeps the row). */
export async function loadDiscordInstall(projectId: string): Promise<DiscordInstall | null> {
  const [row] = await db
    .select({ guildId: chatInstalls.platformTeamId, metadata: projectsView.metadata })
    .from(chatInstalls)
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatInstalls.projectId), eq(projectsView.status, 'active')))
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  return {
    guildId: row.guildId,
    guildName: (await readSecret(projectId, DISCORD_GUILD_NAME)) || null,
    ...readChannelAccess(row.metadata, 'discord'),
  };
}

/** The active projects the guild is installed in, oldest install first. */
export async function discordGuildProjects(guildId: string): Promise<string[]> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .innerJoin(projectsView, and(eq(projectsView.projectId, chatInstalls.projectId), eq(projectsView.status, 'active')))
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.platformTeamId, guildId)))
    .orderBy(chatInstalls.connectedAt);
  return rows.map((r) => r.projectId);
}

/**
 * Disconnect and the project delete: the install, its bindings, settings,
 * conversations (threads and DMs), secret and requests go. The allowed list stays for a reconnect. When no
 * project has the guild any more, the bot leaves it (best effort), so it reads
 * no more of its messages.
 */
export async function releaseDiscordInstall(projectId: string): Promise<void> {
  const [removed] = await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.projectId, projectId)))
    .returning({ guildId: chatInstalls.platformTeamId });
  await deleteDiscordBindings(projectId);
  // Its sessions' threads and DMs: no longer this project's conversations (the connector gate reads them).
  await db.delete(chatThreads).where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.projectId, projectId)));
  await deleteProjectSecrets(projectId, [DISCORD_GUILD_NAME]);
  await clearChannelAccessRequests('discord', projectId);
  if (removed && discordConfigured() && (await discordGuildProjects(removed.guildId).catch(() => ['?'])).length === 0) {
    await leaveDiscordGuild(removed.guildId);
  }
}

/** The bot leaves a guild no project has. Never throws. */
export async function leaveDiscordGuild(guildId: string): Promise<void> {
  try {
    await discordCall('DELETE /users/@me/guilds/{id}', `/users/@me/guilds/${guildId}`, { method: 'DELETE', timeoutMs: 5_000 });
  } catch (error) {
    logger.warn('[discord] the bot stayed in a server no project has', { error: String(error) });
  }
}

/** Every install of a guild the bot was removed from (Gateway `GUILD_DELETE`). */
export async function forgetDiscordGuild(guildId: string): Promise<string[]> {
  const removed = await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'discord'), eq(chatInstalls.platformTeamId, guildId)))
    .returning({ projectId: chatInstalls.projectId });
  for (const { projectId } of removed) {
    await deleteDiscordBindings(projectId);
    await clearChannelAccessRequests('discord', projectId);
  }
  await db.delete(chatThreads).where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.platformTeamId, guildId)));
  return removed.map((r) => r.projectId);
}

/** A channel or thread Discord deleted: its conversation and its binding go, for every project. */
export async function forgetDiscordChannel(channelId: string): Promise<void> {
  await db.delete(chatThreads).where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.threadId, channelId)));
  await db.delete(chatChannelBindings).where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, channelId)));
}
