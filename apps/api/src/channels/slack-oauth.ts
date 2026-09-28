import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { slackOauthMode } from './slack-oauth-mode';
import { saveSlackOauthInstall } from './install-store';
import { chatUser, linkChatIdentity, lookupChatIdentity } from './core/identity';
import {
  frontendBase,
  installHandoffUrl,
  stateForCaller,
  type InstallCompletion,
} from './core/install-completion';
import { reconcileChannelConnectors } from '../connectors/sync';
import { makeOpenApiApp, errors } from '../openapi';
import { signChannelState, verifyChannelState } from './core/signed-state';

const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  projectId: string;
  userId: string;
}

function signState(payload: StatePayload): string {
  return signChannelState('slack-install', { ...payload }, STATE_TTL_MS);
}

function verifyState(token: string): StatePayload | null {
  const payload = verifyChannelState('slack-install', token);
  if (!payload) return null;
  if (typeof payload.projectId !== 'string' || typeof payload.userId !== 'string') return null;
  return { projectId: payload.projectId, userId: payload.userId };
}

export function buildSlackInstallUrl(projectId: string, userId: string): string {
  const mode = slackOauthMode();
  if (!mode.available || !mode.clientId) {
    throw new Error('Slack OAuth is not configured on this server.');
  }
  const state = signState({ projectId, userId });
  const params = new URLSearchParams({
    client_id: mode.clientId,
    scope: mode.scopes,
    state,
  });
  if (mode.redirectUri) params.set('redirect_uri', mode.redirectUri);
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export const slackOauthApp = makeOpenApiApp();

// The registered redirect URI. It installs nothing: see install-completion.ts.
slackOauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/callback',
    tags: ['channels'],
    summary: 'Slack OAuth install callback (hands off to the web completion page)',
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect to the web completion page or the Kortix dashboard' },
      ...errors(400, 503),
    },
  }),
  async (c: any) => {
    const mode = slackOauthMode();
    if (!mode.available || !mode.clientId || !mode.clientSecret) {
      return c.json({ error: 'Slack OAuth is not configured on this server.' }, 503);
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    const slackError = c.req.query('error');
    const payload = state ? verifyState(state) : null;
    if (slackError) return c.redirect(dashboardUrl({ projectId: payload?.projectId, error: slackError }), 302);
    if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
    if (!payload) return c.json({ error: 'Invalid or expired state' }, 400);
    return c.redirect(installHandoffUrl('slack', { projectId: payload.projectId, code, state }), 302);
  },
);

/**
 * Finish a Slack OAuth install for the signed-in caller. The caller must be
 * the Kortix user who started it, for the same project; the code is exchanged
 * only after that check.
 */
export async function completeSlackOauthInstall(input: {
  projectId: string;
  userId: string;
  code: string;
  state: string;
}): Promise<InstallCompletion> {
  // The state is checked first, so a bad or foreign state answers the same on
  // every deployment; only a valid one learns whether Slack OAuth is set up.
  const checked = stateForCaller(verifyState(input.state), input);
  if (!checked.ok) return checked;
  const payload = checked.state;
  const mode = slackOauthMode();
  if (!mode.available || !mode.clientId || !mode.clientSecret) {
    return { ok: false, status: 503, error: 'Slack OAuth is not configured on this server.' };
  }
  const done = (qs: Record<string, string | undefined>): InstallCompletion => ({
    ok: true,
    redirectUrl: dashboardUrl({ projectId: payload.projectId, ...qs }),
  });

  const exchangeBody = new URLSearchParams({
    code: input.code,
    client_id: mode.clientId,
    client_secret: mode.clientSecret,
  });
  if (mode.redirectUri) exchangeBody.set('redirect_uri', mode.redirectUri);

  let tokenJson: SlackOauthResponse;
  try {
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: exchangeBody.toString(),
    });
    tokenJson = (await tokenRes.json()) as SlackOauthResponse;
  } catch (err) {
    console.error('[slack-oauth] token exchange failed', {
      projectId: payload.projectId,
      error: (err as Error).message,
    });
    return done({ error: 'oauth_exchange_failed' });
  }
  if (!tokenJson.ok || !tokenJson.access_token || !tokenJson.team?.id) {
    return done({ error: tokenJson.error ?? 'oauth_exchange_failed' });
  }

  let project: { projectId: string } | undefined;
  try {
    [project] = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(eq(projects.projectId, payload.projectId))
      .limit(1);
  } catch (err) {
    console.error('[slack-oauth] project lookup failed', {
      projectId: payload.projectId,
      workspaceId: tokenJson.team.id,
      error: (err as Error).message,
    });
    return done({ error: 'project_lookup_failed' });
  }
  if (!project) return done({ error: 'project_not_found' });

  try {
    await saveSlackOauthInstall({
      projectId: payload.projectId,
      workspaceId: tokenJson.team.id,
      botToken: tokenJson.access_token,
      botUserId: tokenJson.bot_user_id ?? '',
      teamName: tokenJson.team.name ?? null,
    });
  } catch (err) {
    console.error('[slack-oauth] install save failed', {
      projectId: payload.projectId,
      workspaceId: tokenJson.team.id,
      error: (err as Error).message,
    });
    return done({ error: 'slack_install_save_failed' });
  }

  // Seed the installer's identity so the admin who just connected is linked
  // immediately and never hits the `/login` block on their own messages. Slack
  // returns the authorizing user as `authed_user.id`. Best-effort, only when
  // the per-user identity feature is on, and never over a live link to another
  // Kortix user: that person re-links through `/login` themselves.
  if (config.SLACK_REQUIRE_USER_IDENTITY && tokenJson.authed_user?.id) {
    try {
      await seedInstallerIdentity({
        teamId: tokenJson.team.id,
        slackUserId: tokenJson.authed_user.id,
        userId: payload.userId,
      });
    } catch (err) {
      console.warn('[slack-oauth] installer identity seed failed', {
        projectId: payload.projectId,
        error: (err as Error).message,
      });
    }
  }

  // Materialize the Slack channel connector so it appears in the Connector right
  // after connecting (best-effort; never blocks the redirect).
  void reconcileChannelConnectors(payload.projectId);

  return done({ success: '1' });
}

/** Link the installer's Slack user to `userId` unless it is linked to someone else. */
export async function seedInstallerIdentity(input: {
  teamId: string;
  slackUserId: string;
  userId: string;
}): Promise<'linked' | 'kept'> {
  const installer = chatUser('slack', input.teamId, input.slackUserId);
  const existing = await lookupChatIdentity(installer);
  if (existing && existing.userId !== input.userId) return 'kept';
  await linkChatIdentity(installer, input.userId);
  return 'linked';
}

/**
 * The dashboard page an install outcome lands on. Mirrors dashboardBaseUrl()'s
 * fallback chain so a deployed environment never redirects to localhost.
 */
function dashboardUrl(qs: Record<string, string | undefined>): string {
  const base = frontendBase();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) {
    if (v) params.set(k, v);
  }
  // Land on the real project page, then let the web shell open Customize from
  // query params. The /customize shim renders null while client routing runs,
  // which is too fragile as an external OAuth landing target.
  if (qs.projectId) params.set('customize', 'connectors');
  return qs.projectId
    ? `${base}/projects/${qs.projectId}?${params.toString()}`
    : `${base}/?${params.toString()}`;
}

interface SlackOauthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  scope?: string;
  team?: { id: string; name?: string };
  authed_user?: { id?: string };
}
