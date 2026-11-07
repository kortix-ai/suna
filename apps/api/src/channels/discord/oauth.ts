/**
 * "Add to Discord": the OAuth2 install of the Kortix Discord application in a
 * server, for one project, like "Add to Slack".
 *
 *   1. The web asks for the install URL (projects/routes/channel-discord.ts):
 *      Discord's authorize page with the bot, the slash commands and `identify`,
 *      the bot's permissions, and a signed state naming the user and project.
 *   2. The person picks a server there; Discord redirects the browser to the
 *      API callback, which installs nothing: it checks the state and hands the
 *      browser to the web completion page (core/install-completion.ts).
 *   3. That page posts the code with the signed-in user's token. Only for the
 *      user and project the state names, the code is exchanged: Discord answers
 *      the server the bot joined (`guild`) and the person's own token, which
 *      names them (`GET /users/@me`). The server is installed, the person is
 *      allowed to talk to the bot, and the `kortix_discord` connector appears.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { config } from '../../config';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { logger } from '../../lib/logger';
import { errors, makeOpenApiApp } from '../../openapi';
import { allowChannelUser } from '../core/channel-access';
import { frontendBase, type InstallCompletion, installHandoffUrl, stateForCaller } from '../core/install-completion';
import { signChannelState, verifyChannelState } from '../core/signed-state';
import { discordApiBase, discordConfigured } from './api';
import { DISCORD_USER_ID, discordGuildProjects, leaveDiscordGuild, saveDiscordInstall } from './installs';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * What the bot may do in a server: view channels, send messages, send in
 * threads, create public threads, read message history, attach files, add
 * reactions, embed links.
 */
export const DISCORD_BOT_PERMISSIONS = [6, 10, 11, 14, 15, 16, 35, 38].reduce((all, bit) => all | (1n << BigInt(bit)), 0n).toString();

/** The redirect URI registered in the Developer Portal: the API callback. */
export function discordRedirectUri(): string {
  return config.DISCORD_REDIRECT_URI || `${config.KORTIX_URL.replace(/\/+$/, '')}/v1/webhooks/discord/oauth/callback`;
}

interface StatePayload {
  projectId: string;
  userId: string;
}

function verifyState(token: string): StatePayload | null {
  const payload = verifyChannelState('discord-install', token);
  if (!payload || typeof payload.projectId !== 'string' || typeof payload.userId !== 'string') return null;
  return { projectId: payload.projectId, userId: payload.userId };
}

export function buildDiscordInstallUrl(projectId: string, userId: string): string {
  if (!discordConfigured()) throw new Error('Discord is not configured on this server.');
  const params = new URLSearchParams({
    client_id: config.DISCORD_APPLICATION_ID,
    scope: 'bot applications.commands identify',
    permissions: DISCORD_BOT_PERMISSIONS,
    response_type: 'code',
    redirect_uri: discordRedirectUri(),
    integration_type: '0',
    state: signChannelState('discord-install', { projectId, userId }, STATE_TTL_MS),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Where an install outcome lands: the project's Connectors page. */
function dashboardUrl(projectId: string | undefined, qs: Record<string, string>): string {
  const params = new URLSearchParams(qs);
  if (!projectId) return `${frontendBase()}/?${params.toString()}`;
  params.set('customize', 'connectors');
  return `${frontendBase()}/workspaces/${projectId}?${params.toString()}`;
}

export const discordOauthApp = makeOpenApiApp();

/** Mounted at `/v1/webhooks/discord/oauth`: the registered redirect URI. It installs nothing. */
export function registerDiscordOauthRoutes(): void {
  discordOauthApp.openapi(
    createRoute({
      method: 'get',
      path: '/callback',
      tags: ['channels'],
      summary: 'Discord OAuth install callback (hands off to the web completion page)',
      request: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          guild_id: z.string().optional(),
          permissions: z.string().optional(),
        }),
      },
      responses: {
        302: { description: 'Redirect to the web completion page or the Kortix dashboard' },
        ...errors(400),
      },
    }),
    async (c: Context) => {
      const code = c.req.query('code');
      const state = c.req.query('state');
      const payload = state ? verifyState(state) : null;
      const refused = c.req.query('error');
      // `access_denied`: the person cancelled on Discord's page.
      if (refused) return c.redirect(dashboardUrl(payload?.projectId, { error: refused.slice(0, 64) }), 302);
      if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
      if (!payload) return c.json({ error: 'Invalid or expired state' }, 400);
      return c.redirect(installHandoffUrl('discord', { projectId: payload.projectId, code, state }), 302);
    },
  );
}

interface TokenResponse {
  access_token?: string;
  guild?: { id?: string; name?: string };
  error?: string;
}

/**
 * Finish a Discord install for the signed-in caller. The caller must be the
 * Kortix user who started it, for the same project; the code is exchanged only
 * after that check.
 */
export async function completeDiscordOauthInstall(input: { projectId: string; userId: string; code: string; state: string }): Promise<InstallCompletion> {
  const checked = stateForCaller(verifyState(input.state), input);
  if (!checked.ok) return checked;
  if (!discordConfigured()) return { ok: false, status: 503, error: 'Discord is not configured on this server.' };
  const done = (qs: Record<string, string>): InstallCompletion => ({ ok: true, redirectUrl: dashboardUrl(input.projectId, qs) });

  let token: TokenResponse;
  try {
    const res = await fetch(`${discordApiBase()}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: discordRedirectUri(),
        client_id: config.DISCORD_APPLICATION_ID,
        client_secret: config.DISCORD_CLIENT_SECRET,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    token = (await res.json().catch(() => ({}))) as TokenResponse;
  } catch (error) {
    logger.warn('[discord] OAuth code exchange failed', { projectId: input.projectId, error: error instanceof Error ? error.name : 'unknown' });
    return done({ error: 'oauth_exchange_failed' });
  }
  const guildId = token.guild?.id;
  if (!token.access_token || !guildId || !/^\d{17,20}$/.test(guildId)) {
    return done({ error: token.error === 'invalid_grant' ? 'oauth_code_expired' : 'discord_no_server' });
  }

  const { replacedGuildId } = await saveDiscordInstall({ projectId: input.projectId, guildId, guildName: token.guild?.name?.slice(0, 100) ?? null });
  // The server this one replaced: the bot leaves it when no other project has it.
  if (replacedGuildId && (await discordGuildProjects(replacedGuildId)).length === 0) await leaveDiscordGuild(replacedGuildId);

  // The installer talks to the bot at once: their Discord account is allowed.
  try {
    const res = await fetch(`${discordApiBase()}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const me = (await res.json().catch(() => ({}))) as { id?: unknown };
    if (typeof me.id === 'string' && DISCORD_USER_ID.test(me.id)) await allowChannelUser('discord', input.projectId, me.id);
  } catch (error) {
    logger.warn('[discord] the installer was not allowed', { projectId: input.projectId, error: error instanceof Error ? error.name : 'unknown' });
  }

  // Awaited: the dashboard reads the connectors right after the redirect (KRTX-2353). Never throws.
  await reconcileChannelConnectors(input.projectId);
  return done({ success: '1', channel: 'discord' });
}
