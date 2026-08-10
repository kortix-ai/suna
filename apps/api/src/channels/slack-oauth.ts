import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { slackOauthMode } from './slack-oauth-mode';
import { saveSlackOauthInstall } from './install-store';
import { linkSlackIdentity } from './slack/identity';
import { reconcileChannelConnectors } from '../connectors/sync';
import { makeOpenApiApp, errors } from '../openapi';

const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  workspaceId: string;
  userId: string;
  exp: number;
  nonce: string;
}

function stateSigningKey(): string {
  return config.SLACK_SIGNING_SECRET ?? 'kortix-dev-state-key';
}

function signState(payload: Omit<StatePayload, 'nonce'>): string {
  const full: StatePayload = { ...payload, nonce: randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const mac = createHmac('sha256', stateSigningKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyState(token: string): StatePayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', stateSigningKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.workspaceId !== 'string' || typeof payload.userId !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSlackInstallUrl(workspaceId: string, userId: string): string {
  const mode = slackOauthMode();
  if (!mode.available || !mode.clientId) {
    throw new Error('Slack OAuth is not configured on this server.');
  }
  const state = signState({ workspaceId, userId, exp: Date.now() + STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: mode.clientId,
    scope: mode.scopes,
    state,
  });
  if (mode.redirectUri) params.set('redirect_uri', mode.redirectUri);
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export const slackOauthApp = makeOpenApiApp();

slackOauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/callback',
    tags: ['channels'],
    summary: 'Slack OAuth install callback (redirects to dashboard)',
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect to the Kortix dashboard' },
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
  if (slackError) return redirectToDashboard(c, { workspaceId: payload?.workspaceId, error: slackError });
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
  if (!payload) return c.json({ error: 'Invalid or expired state' }, 400);

  const exchangeBody = new URLSearchParams({
    code,
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
      workspaceId: payload.workspaceId,
      error: (err as Error).message,
    });
    return redirectToDashboard(c, { workspaceId: payload.workspaceId, error: 'oauth_exchange_failed' });
  }
  if (!tokenJson.ok || !tokenJson.access_token || !tokenJson.team?.id) {
    return redirectToDashboard(c, {
      workspaceId: payload.workspaceId,
      error: tokenJson.error ?? 'oauth_exchange_failed',
    });
  }

  let workspace: { workspaceId: string } | undefined;
  try {
    [workspace] = await db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.workspaceId, payload.workspaceId))
      .limit(1);
  } catch (err) {
    console.error('[slack-oauth] workspace lookup failed', {
      workspaceId: payload.workspaceId,
      platformWorkspaceId: tokenJson.team.id,
      error: (err as Error).message,
    });
    return redirectToDashboard(c, { workspaceId: payload.workspaceId, error: 'workspace_lookup_failed' });
  }
  if (!workspace) {
    return redirectToDashboard(c, { workspaceId: payload.workspaceId, error: 'workspace_not_found' });
  }

  try {
    await saveSlackOauthInstall({
      workspaceId: payload.workspaceId,
      platformWorkspaceId: tokenJson.team.id,
      botToken: tokenJson.access_token,
      botUserId: tokenJson.bot_user_id ?? '',
      teamName: tokenJson.team.name ?? null,
    });
  } catch (err) {
    console.error('[slack-oauth] install save failed', {
      workspaceId: payload.workspaceId,
      platformWorkspaceId: tokenJson.team.id,
      error: (err as Error).message,
    });
    return redirectToDashboard(c, { workspaceId: payload.workspaceId, error: 'slack_install_save_failed' });
  }

  // Seed the installer's identity so the admin who just connected is linked
  // immediately and never hits the `/login` block on their own messages. Slack
  // returns the authorizing user as `authed_user.id`. Best-effort, and only when
  // the per-user identity feature is enabled (the whole feature is flag-gated).
  if (config.SLACK_REQUIRE_USER_IDENTITY && tokenJson.authed_user?.id) {
    try {
      await linkSlackIdentity({
        teamId: tokenJson.team.id,
        slackUserId: tokenJson.authed_user.id,
        userId: payload.userId,
      });
    } catch (err) {
      console.warn('[slack-oauth] installer identity seed failed', {
        workspaceId: payload.workspaceId,
        error: (err as Error).message,
      });
    }
  }

  // Materialize the Slack channel connector so it appears in the Connector right
  // after connecting (best-effort; never blocks the redirect).
  void reconcileChannelConnectors(payload.workspaceId);

  return redirectToDashboard(c, { workspaceId: payload.workspaceId, success: '1' });
},
);

function redirectToDashboard(
  c: Context,
  qs: Record<string, string | undefined>,
): Response {
  // Mirror dashboardBaseUrl()'s fallback chain so an OAuth callback never
  // redirects to localhost in a deployed environment where FRONTEND_URL
  // happens to be unset.
  const base = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) {
    if (v) params.set(k, v);
  }
  // Land on the real workspace page, then let the web shell open Customize from
  // query params. The /customize shim renders null while client routing runs,
  // which is too fragile as an external OAuth callback target.
  if (qs.workspaceId) params.set('customize', 'connectors');
  const target = qs.workspaceId
    ? `${base}/workspaces/${qs.workspaceId}?${params.toString()}`
    : `${base}/?${params.toString()}`;
  return c.redirect(target, 302);
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
