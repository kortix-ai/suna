import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { makeOpenApiApp } from '../openapi';
import { reconcileChannelConnectors } from '../executor/sync';
import { saveTeamsInstall, setTeamsOrgInstalled } from './install-store';
import { publishTeamsAppToCatalog } from './teams/catalog';

const STATE_TTL_MS = 10 * 60 * 1000;

interface OauthState {
  projectId: string;
  baseUrl: string;
  exp: number;
  nonce: string;
}

function stateKey(): string {
  return config.MICROSOFT_APP_PASSWORD ?? 'kortix-dev-teams-oauth-key';
}

function signState(projectId: string, baseUrl: string): string {
  const full: OauthState = { projectId, baseUrl, exp: Date.now() + STATE_TTL_MS, nonce: randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const mac = createHmac('sha256', stateKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyState(token: string | undefined): OauthState | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', stateKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OauthState;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.projectId !== 'string' || typeof payload.baseUrl !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

export function teamsOrgConsentUrl(input: { projectId: string; baseUrl: string }): string | null {
  const appId = config.MICROSOFT_APP_ID;
  if (!appId) return null;
  const redirect = `${input.baseUrl.replace(/\/+$/, '')}/v1/webhooks/teams/oauth/callback`;
  const url = new URL('https://login.microsoftonline.com/organizations/v2.0/adminconsent');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('scope', 'https://graph.microsoft.com/.default');
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', signState(input.projectId, input.baseUrl));
  return url.toString();
}

export const teamsOauthApp = makeOpenApiApp();

teamsOauthApp.get('/callback', async (c: any) => {
  const frontend = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
  const state = verifyState(c.req.query('state'));
  if (!state) return c.redirect(`${frontend}/?teams_error=expired`, 302);

  const dest = (status: string) => `${frontend}/projects/${state.projectId}?teams=${status}`;

  if (c.req.query('error') || c.req.query('admin_consent') !== 'True') {
    return c.redirect(dest('declined'), 302);
  }
  const tenantId = c.req.query('tenant');
  if (!tenantId) return c.redirect(dest('declined'), 302);
  const appId = config.MICROSOFT_APP_ID;
  if (!appId) return c.redirect(dest('unconfigured'), 302);

  await saveTeamsInstall({ projectId: state.projectId, tenantId }).catch((err) =>
    console.error('[teams-oauth] saveTeamsInstall failed', err),
  );
  const published = await publishTeamsAppToCatalog({ tenantId, baseUrl: state.baseUrl, appId }).catch(() => ({
    ok: false,
  }));
  if (published.ok) await setTeamsOrgInstalled(state.projectId, true).catch(() => {});
  void reconcileChannelConnectors(state.projectId);

  return c.redirect(dest(published.ok ? 'connected' : 'consented'), 302);
});
