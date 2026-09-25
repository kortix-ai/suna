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
import { signChannelState, verifyChannelState } from './core/signed-state';
import { frontendBase, installHandoffUrl, stateForCaller, type InstallCompletion } from './core/install-completion';

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
  /** The Kortix user who started the install. Only they may complete it. */
  userId: string;
  baseUrl: string;
}

function callbackRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/webhooks/teams/oauth/callback`;
}

function signState(state: OauthState): string {
  return signChannelState('teams-oauth', { ...state }, STATE_TTL_MS);
}

function verifyState(token: string | undefined): OauthState | null {
  const payload = verifyChannelState('teams-oauth', token);
  if (!payload) return null;
  if (
    typeof payload.projectId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.baseUrl !== 'string'
  ) {
    return null;
  }
  return { projectId: payload.projectId, userId: payload.userId, baseUrl: payload.baseUrl };
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
  /** The Kortix user starting the install; only they can complete it. */
  userId: string;
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
  url.searchParams.set('state', signState({ projectId: input.projectId, userId: input.userId, baseUrl: input.baseUrl }));
  return url.toString();
}

export const teamsOauthApp = makeOpenApiApp();

/**
 * Where an install outcome lands: the Channels surface (a scope of
 * Connectors), where the Teams row renders the persisted publish state.
 */
function channelsUrl(projectId: string, status: TeamsInstallRedirectStatus): string {
  return `${frontendBase()}/projects/${projectId}/customize/connectors?scope=channels&teams=${status}`;
}

// The registered redirect URI. It installs nothing: see install-completion.ts.
teamsOauthApp.get('/callback', async (c: any) => {
  const rawState = c.req.query('state');
  const state = verifyState(rawState);
  if (!state) return c.redirect(`${frontendBase()}/?teams_error=expired`, 302);
  const dest = (status: TeamsInstallRedirectStatus) => channelsUrl(state.projectId, status);

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
  if (!config.MICROSOFT_APP_ID) return c.redirect(dest('unconfigured'), 302);
  return c.redirect(installHandoffUrl('teams', { projectId: state.projectId, code, state: rawState }), 302);
});

/**
 * Finish a Teams org install for the signed-in caller. The caller must be the
 * Kortix user who started it, for the same project; the code is exchanged only
 * after that check.
 */
export async function completeTeamsOauthInstall(input: {
  projectId: string;
  userId: string;
  code: string;
  state: string;
}): Promise<InstallCompletion> {
  const checked = stateForCaller(verifyState(input.state), input);
  if (!checked.ok) return checked;
  const state = checked.state;
  const done = (status: TeamsInstallRedirectStatus): InstallCompletion => ({
    ok: true,
    redirectUrl: channelsUrl(state.projectId, status),
  });

  if (!(await projectFeatureFlagEnabled(state.projectId, 'teams'))) return done('disabled');
  const appId = config.MICROSOFT_APP_ID;
  if (!appId) return done('unconfigured');

  const token = await exchangeCodeForToken(input.code, state.baseUrl);
  if (!token) return done('failed');
  const tenantId = token.tenantId;
  if (!tenantId) return done('failed');

  await saveTeamsInstall({ projectId: state.projectId, tenantId }).catch((err) =>
    console.error('[teams-oauth] saveTeamsInstall failed', err),
  );
  void reconcileChannelConnectors(state.projectId);

  // The publish runs to completion regardless of the response; the browser
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
  return done(status);
}
