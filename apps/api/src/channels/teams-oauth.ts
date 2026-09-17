import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { makeOpenApiApp } from '../openapi';
import { reconcileChannelConnectors } from '../connectors/sync';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import {
  saveTeamsInstall,
  setTeamsCatalogAppId,
  setTeamsOrgInstalled,
  setTeamsPublishState,
} from './install-store';
import { publishTeamsAppToCatalog } from './teams/catalog';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * How long the callback waits for the org-catalog publish before redirecting
 * anyway. The publish itself runs to completion in the background either way
 * (its outcome lands on the install via setTeamsPublishState); this only decides
 * whether the browser sees the final status or `?teams=publishing` and polls.
 * A first publish measured 21 s (2026-09-17), which is longer than a load
 * balancer should hold a redirect, so the browser is never held past this.
 */
const TEAMS_PUBLISH_REDIRECT_WAIT_MS = 8_000;
let publishRedirectWaitMs: number | null = null;

export function setTeamsPublishRedirectWaitForTest(ms: number | null): void {
  publishRedirectWaitMs = ms;
}

export type TeamsInstallRedirectStatus =
  | 'connected'
  | 'review'
  | 'failed'
  | 'publishing'
  | 'declined'
  | 'disabled'
  | 'unconfigured';

/**
 * Run the catalog publish and persist its outcome. Never throws: a thrown
 * publish is a `failed` outcome with the message as the reason.
 */
async function runCatalogPublish(input: {
  projectId: string;
  accessToken: string;
  baseUrl: string;
  appId: string;
  tenantId: string;
}): Promise<Exclude<TeamsInstallRedirectStatus, 'publishing' | 'declined' | 'disabled' | 'unconfigured'>> {
  const { projectId } = input;
  await setTeamsPublishState(projectId, 'publishing').catch(() => {});
  let published: Awaited<ReturnType<typeof publishTeamsAppToCatalog>>;
  try {
    published = await publishTeamsAppToCatalog({
      accessToken: input.accessToken,
      baseUrl: input.baseUrl,
      appId: input.appId,
      appName: config.TEAMS_APP_NAME,
    });
  } catch (err) {
    published = { ok: false, published: false, error: (err as Error)?.message ?? 'publish failed' };
  }

  let status: 'connected' | 'review' | 'failed';
  if (published.published) {
    status = 'connected';
    await setTeamsOrgInstalled(projectId, true).catch(() => {});
    if (published.teamsAppId) await setTeamsCatalogAppId(projectId, published.teamsAppId).catch(() => {});
    await setTeamsPublishState(projectId, 'published').catch(() => {});
  } else if (published.pendingReview) {
    status = 'review';
    if (published.teamsAppId) await setTeamsCatalogAppId(projectId, published.teamsAppId).catch(() => {});
    await setTeamsPublishState(projectId, 'review').catch(() => {});
  } else {
    status = 'failed';
    await setTeamsPublishState(projectId, 'failed', published.error ?? 'publish failed').catch(() => {});
  }

  console.info('[teams-oauth] install complete', {
    projectId,
    tenantId: input.tenantId,
    status,
    teamsAppId: published.teamsAppId ?? null,
    error: published.error ?? null,
  });
  return status;
}
const GRAPH_PUBLISH_SCOPE = 'https://graph.microsoft.com/AppCatalog.ReadWrite.All offline_access openid';
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';

interface OauthState {
  projectId: string;
  baseUrl: string;
  exp: number;
  nonce: string;
}

function stateKey(): string {
  return config.MICROSOFT_APP_PASSWORD ?? 'kortix-dev-teams-oauth-key';
}

function callbackRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/webhooks/teams/oauth/callback`;
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

function tenantFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { tid?: string };
    return typeof payload.tid === 'string' ? payload.tid : null;
  } catch {
    return null;
  }
}

async function exchangeCodeForToken(
  code: string,
  baseUrl: string,
): Promise<{ accessToken: string; tenantId: string | null } | null> {
  const appId = config.MICROSOFT_APP_ID;
  const secret = config.MICROSOFT_APP_PASSWORD;
  if (!appId || !secret) return null;
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: secret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackRedirectUri(baseUrl),
    scope: GRAPH_PUBLISH_SCOPE,
  });
  let res: Response;
  try {
    res = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error('[teams-oauth] token exchange error', (err as Error)?.message);
    return null;
  }
  const text = await res.text();
  if (!res.ok) {
    console.warn('[teams-oauth] token exchange failed', { status: res.status, body: text.slice(0, 300) });
    return null;
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed.access_token) return null;
  return { accessToken: parsed.access_token, tenantId: tenantFromJwt(parsed.access_token) };
}

/**
 * Authorization-code URL for the one-click install. A Teams admin signs in
 * once and consents to the delegated AppCatalog.ReadWrite.All scope; the
 * callback exchanges the code for a delegated token and publishes the app to
 * the org catalog. (App-only publishing is not supported by Graph — see
 * teams/catalog.ts.)
 */
export function teamsOrgConsentUrl(input: {
  projectId: string;
  baseUrl: string;
  enabled: boolean;
}): string | null {
  const appId = config.MICROSOFT_APP_ID;
  if (!appId || !input.enabled) return null;
  const url = new URL(`${AUTHORITY}/authorize`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('redirect_uri', callbackRedirectUri(input.baseUrl));
  url.searchParams.set('scope', GRAPH_PUBLISH_SCOPE);
  url.searchParams.set('state', signState(input.projectId, input.baseUrl));
  return url.toString();
}

export const teamsOauthApp = makeOpenApiApp();

teamsOauthApp.get('/callback', async (c: any) => {
  const frontend = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
  const state = verifyState(c.req.query('state'));
  if (!state) return c.redirect(`${frontend}/?teams_error=expired`, 302);

  // Land on the Channels surface (a scope of Connectors), where the Teams row
  // renders the persisted publish state — not the project home, which reads
  // nothing from the query.
  const dest = (status: TeamsInstallRedirectStatus) =>
    `${frontend}/projects/${state.projectId}/customize/connectors?scope=channels&teams=${status}`;

  // The flag is per project, so it can only be read once the signed state
  // tells us which project this consent belongs to.
  if (!(await projectFeatureFlagEnabled(state.projectId, 'teams'))) {
    return c.redirect(dest('disabled'), 302);
  }

  if (c.req.query('error')) {
    console.warn('[teams-oauth] authorize error', {
      error: c.req.query('error'),
      description: c.req.query('error_description')?.slice(0, 200),
    });
    return c.redirect(dest('declined'), 302);
  }
  const code = c.req.query('code');
  if (!code) return c.redirect(dest('declined'), 302);
  const appId = config.MICROSOFT_APP_ID;
  if (!appId) return c.redirect(dest('unconfigured'), 302);

  const token = await exchangeCodeForToken(code, state.baseUrl);
  if (!token) return c.redirect(dest('failed'), 302);
  const tenantId = token.tenantId;
  if (!tenantId) return c.redirect(dest('failed'), 302);

  await saveTeamsInstall({ projectId: state.projectId, tenantId }).catch((err) =>
    console.error('[teams-oauth] saveTeamsInstall failed', err),
  );
  void reconcileChannelConnectors(state.projectId);

  // The publish runs to completion regardless of the redirect; the browser
  // only waits a bounded time for it.
  const publish = runCatalogPublish({
    projectId: state.projectId,
    accessToken: token.accessToken,
    baseUrl: state.baseUrl,
    appId,
    tenantId,
  });
  publish.catch((err) => console.error('[teams-oauth] catalog publish crashed', err));

  const waitMs = publishRedirectWaitMs ?? TEAMS_PUBLISH_REDIRECT_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race<TeamsInstallRedirectStatus>([
    publish,
    new Promise<TeamsInstallRedirectStatus>((resolve) => {
      timer = setTimeout(() => resolve('publishing'), waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return c.redirect(dest(status), 302);
});
