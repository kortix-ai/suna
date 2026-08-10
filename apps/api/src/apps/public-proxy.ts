import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  markComputeSessionAlive,
  pauseComputeSession,
  startComputeSession,
} from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { AppBudgetExceededError, assertAppBudgetAvailable } from './budget';
import { AppHostingProvider } from './hosting';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { enqueueCurrentAppRuntime } from './deployment-worker';
import {
  appAccessCookie,
  appAccessCookieName,
  appAccessibleToUser,
  appAccessSecret,
  cookieValue,
  createAppAccessToken,
  verifyAppAccessToken,
  type AppAccessMode,
} from './access';

const EDGE_HOST_HEADER = 'x-kortix-app-host';
const EDGE_TIMESTAMP_HEADER = 'x-kortix-app-timestamp';
const EDGE_SIGNATURE_HEADER = 'x-kortix-app-signature';
const EDGE_MAX_SKEW_MS = 5 * 60_000;
const WAKE_LEASE_MS = 2 * 60_000;
const ACTIVITY_LEASE_MS = 60_000;
const APP_FRAME_ANCESTORS =
  "frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*";

function appWakeSupersededResponse(): Response {
  return Response.json({
    error: 'App start was superseded by a newer lifecycle request',
    code: 'app_start_superseded',
  }, { status: 409 });
}

type PublicDeploymentStatus =
  | 'queued'
  | 'validating'
  | 'building'
  | 'provisioning'
  | 'checking'
  | 'ready'
  | 'failed'
  | 'cancelled';

type PublicAppStatus = PublicDeploymentStatus | 'waiting' | 'starting' | 'budget';

const PUBLIC_STATUS_COPY: Record<PublicAppStatus, {
  title: string;
  message: string;
  code: string;
  progress: boolean;
  httpStatus?: number;
}> = {
  waiting: {
    title: 'Waiting for first deployment',
    message: 'Deploy from a linked project with kortix apps deploy .',
    code: 'app_waiting_for_deployment',
    progress: true,
  },
  queued: {
    title: 'Deployment queued',
    message: 'Kortix will start this deployment shortly.',
    code: 'app_deployment_queued',
    progress: true,
  },
  validating: {
    title: 'Validating your App',
    message: 'Kortix is checking the source and deployment configuration.',
    code: 'app_deployment_validating',
    progress: true,
  },
  building: {
    title: 'Building your App',
    message: 'Kortix is producing an immutable runtime image.',
    code: 'app_deployment_building',
    progress: true,
  },
  provisioning: {
    title: 'Provisioning your App',
    message: 'Kortix is creating the serverless runtime.',
    code: 'app_deployment_provisioning',
    progress: true,
  },
  checking: {
    title: 'Checking readiness',
    message: 'Kortix is waiting for the App to accept traffic.',
    code: 'app_deployment_checking',
    progress: true,
  },
  ready: {
    title: 'Activating your App',
    message: 'The deployment is ready. Kortix is assigning stable traffic.',
    code: 'app_deployment_activating',
    progress: true,
  },
  starting: {
    title: 'Starting your App',
    message: 'Kortix is resuming the serverless runtime. This page will continue automatically.',
    code: 'app_starting',
    progress: true,
  },
  budget: {
    title: 'App paused',
    message: 'This App reached its monthly compute limit. The owner can increase the limit in Kortix Apps.',
    code: 'app_budget_exceeded',
    progress: false,
    httpStatus: 402,
  },
  failed: {
    title: 'Deployment failed',
    message: 'Open Kortix Apps or run kortix apps logs to inspect the deployment.',
    code: 'app_deployment_failed',
    progress: false,
  },
  cancelled: {
    title: 'Deployment cancelled',
    message: 'Deploy a new version to make this App available.',
    code: 'app_deployment_cancelled',
    progress: false,
  },
};

function appBrowserNavigation(request: Request): boolean {
  const accept = request.headers.get('accept') || '';
  const destination = request.headers.get('sec-fetch-dest') || '';
  return accept.includes('text/html') || ['document', 'iframe', 'frame'].includes(destination);
}

function publicDeploymentStatus(deployment: { status: string } | null): {
  status: PublicDeploymentStatus | 'starting';
} | null {
  if (!deployment) return null;
  if (
    deployment.status === 'queued' ||
    deployment.status === 'validating' ||
    deployment.status === 'building' ||
    deployment.status === 'provisioning' ||
    deployment.status === 'checking' ||
    deployment.status === 'ready' ||
    deployment.status === 'failed' ||
    deployment.status === 'cancelled'
  ) {
    return { status: deployment.status };
  }
  return { status: 'starting' };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function appPublicStatusResponse(
  request: Request,
  app: { name: string },
  deployment: { status: PublicAppStatus } | null,
): Response {
  const status = deployment?.status ?? 'waiting';
  const copy = PUBLIC_STATUS_COPY[status];
  const httpStatus = copy.httpStatus ?? (copy.progress ? 202 : 503);
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  if (copy.progress) headers.set('retry-after', '3');

  if (!appBrowserNavigation(request)) {
    return Response.json({
      error: status === 'waiting'
        ? 'App is waiting for its first deployment'
        : status === 'budget'
          ? 'App compute budget reached'
        : `App deployment is ${status === 'checking' ? 'checking readiness' : status}`,
      code: copy.code,
      status,
    }, { status: httpStatus, headers });
  }

  const name = escapeHtml(app.name);
  const refresh = copy.progress ? '<meta http-equiv="refresh" content="3">' : '';
  const documentTitle = status === 'building'
    ? `Building ${name}`
    : status === 'starting'
      ? `Starting ${name}`
    : `${escapeHtml(copy.title)} · ${name}`;
  const heading = status === 'starting' ? `Starting ${name}` : escapeHtml(copy.title);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${documentTitle}</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:light-dark(#f6f6f3,#10100f);color:light-dark(#171716,#f4f4f1);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,420px);padding:24px;border:1px solid light-dark(#deded9,#30302e);border-radius:12px;background:light-dark(#fff,#191918)}.mark{display:flex;align-items:center;gap:9px;margin-bottom:28px;font-weight:650}.glyph{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:currentColor}.glyph:after{content:"K";color:light-dark(#fff,#191918);font-size:12px}.state{display:flex;align-items:center;gap:9px;color:light-dark(#666662,#aaa9a3);font-size:12px}.dot{width:8px;height:8px;border-radius:999px;background:${copy.progress ? '#e6a522' : '#d74a4a'}${copy.progress ? ';animation:pulse 1.4s ease-in-out infinite' : ''}}h1{margin:12px 0 6px;font-size:20px;line-height:1.25;letter-spacing:-.02em}p{margin:0;color:light-dark(#666662,#aaa9a3)}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}@keyframes pulse{50%{opacity:.35;transform:scale(.8)}}@media(prefers-reduced-motion:reduce){.dot{animation:none}}</style></head>
<body><main class="card"><div class="mark"><span class="glyph"></span>Kortix Apps</div><div class="state"><span class="dot"></span>${escapeHtml(status)}</div><h1>${heading}</h1><p>${escapeHtml(copy.message)}</p></main></body></html>`, {
    status: httpStatus,
    headers,
  });
}

export function appPublicUnavailableResponse(
  request = new Request('https://apps.kortix.com/'),
  app: { name: string } = { name: 'App' },
): Response {
  return appPublicStatusResponse(request, app, { status: 'starting' });
}

/**
 * Provider ingress can trail appd readiness for the first request after a
 * resume. Hide that provider-only 502 behind the normal cold-start contract.
 * A warm App owns its HTTP status, including intentional application 502s.
 */
export function appColdStartUpstreamResponse(
  request: Request,
  app: { name: string },
  coldStart: boolean,
  upstreamStatus: number,
): Response | null {
  return coldStart && upstreamStatus === 502
    ? appPublicUnavailableResponse(request, app)
    : null;
}

export function appProviderStoppedResponse(
  provider: SandboxProviderName,
  status: number,
  body: string,
): boolean {
  return provider === 'daytona' && status === 400 && (
    body.includes('no IP address found') || body.includes('failed to get runner info')
  );
}

export function appPublicBudgetResponse(
  request: Request,
  app: { name: string },
): Response {
  return appPublicStatusResponse(request, app, { status: 'budget' });
}

function accessTokenMatchesMode(
  token: ReturnType<typeof verifyAppAccessToken>,
  app: { accessMode: string; accessRevision: number },
): boolean {
  if (!token || token.revision !== app.accessRevision) return false;
  return app.accessMode === 'password' ? token.kind === 'password' : token.kind === 'kortix';
}

type AppAccessRow = {
  appId: string;
  accountId: string;
  workspaceId: string;
  name: string;
  accessMode: string;
  accessPasswordHash: string | null;
  accessRevision: number;
  createdBy: string | null;
  updatedAt: Date;
};

type AppUserAccessVerifier = (app: AppAccessRow, userId: string) => Promise<boolean>;

async function accessTokenAuthorizesRequest(
  token: ReturnType<typeof verifyAppAccessToken>,
  app: AppAccessRow,
  verifyUserAccess: AppUserAccessVerifier,
): Promise<boolean> {
  if (!accessTokenMatchesMode(token, app)) return false;
  if (token!.kind === 'password') return true;
  return Boolean(token!.userId && await verifyUserAccess(app, token!.userId));
}

function safeAppReturnTo(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function appAccessResponse(
  request: Request,
  app: { appId: string; workspaceId: string; name: string; accessMode: string },
  invalidPassword = false,
  returnTo = safeAppReturnTo(new URL(request.url).pathname + new URL(request.url).search),
): Response {
  const mode = app.accessMode as AppAccessMode;
  if (!appBrowserNavigation(request)) {
    return Response.json(
      { error: 'App authentication required', code: 'app_auth_required', access_mode: mode },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }
  const name = escapeHtml(app.name);
  const isPassword = mode === 'password';
  const action = isPassword
    ? `<form method="post" action="/_kortix/access/password"><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" required autocomplete="current-password"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button type="submit">Open App</button>${invalidPassword ? '<p class="error" role="alert">The password is incorrect.</p>' : ''}</form>`
    : `<a class="button" href="${escapeHtml(`${config.FRONTEND_URL.replace(/\/$/, '')}/projects/${app.workspaceId}/apps?open_app=${app.appId}`)}">Continue with Kortix</a>`;
  const message = isPassword
    ? 'Enter the password configured by the App owner.'
    : 'Sign in with a Kortix account that can access this App.';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access ${name}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:light-dark(#f6f6f3,#10100f);color:light-dark(#171716,#f4f4f1);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,420px);padding:24px;border:1px solid light-dark(#deded9,#30302e);border-radius:12px;background:light-dark(#fff,#191918)}.mark{margin-bottom:28px;font-weight:650}h1{margin:0 0 6px;font-size:20px;letter-spacing:-.02em}p{margin:0 0 20px;color:light-dark(#666662,#aaa9a3)}form{display:grid;gap:10px}label{font-size:12px;font-weight:600}input{width:100%;height:42px;padding:0 12px;border:1px solid light-dark(#c9c9c3,#3a3a37);border-radius:8px;background:transparent;color:inherit}button,.button{display:flex;align-items:center;justify-content:center;height:42px;padding:0 16px;border:0;border-radius:999px;background:light-dark(#171716,#f4f4f1);color:light-dark(#fff,#171716);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.error{margin:0;color:#d74a4a;font-size:12px}</style></head><body><main class="card"><div class="mark">Kortix Apps</div><h1>${name}</h1><p>${escapeHtml(message)}</p>${action}</main></body></html>`, {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; ${APP_FRAME_ANCESTORS}`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function authorizeAppRequest(
  request: Request,
  url: URL,
  app: AppAccessRow,
  verifyUserAccess: AppUserAccessVerifier = appAccessibleToUser,
): Promise<Response | null> {
  if (app.accessMode === 'public') return null;
  const localHttp = url.protocol === 'http:' && url.hostname.endsWith('.apps.localhost');
  const secret = appAccessSecret();
  const queryToken = url.searchParams.get('__kortix_access');
  if (queryToken && (request.method === 'GET' || request.method === 'HEAD')) {
    const verified = verifyAppAccessToken(queryToken, app.appId, secret);
    if (await accessTokenAuthorizesRequest(verified, app, verifyUserAccess)) {
      const session = createAppAccessToken({
        appId: app.appId,
        kind: verified!.kind,
        userId: verified!.userId,
        revision: app.accessRevision,
        expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      }, secret);
      url.searchParams.delete('__kortix_access');
      return new Response(null, {
        status: 303,
        headers: {
          location: `${url.pathname}${url.search}`,
          'set-cookie': appAccessCookie(session, 8 * 60 * 60, localHttp),
        },
      });
    }
  }
  const browserToken = cookieValue(request, appAccessCookieName(localHttp));
  if (
    browserToken &&
    await accessTokenAuthorizesRequest(
      verifyAppAccessToken(browserToken, app.appId, secret),
      app,
      verifyUserAccess,
    )
  ) {
    return null;
  }
  if (app.accessMode === 'password' && request.method === 'POST' && url.pathname === '/_kortix/access/password') {
    const form = await request.formData().catch(() => null);
    const password = String(form?.get('password') ?? '');
    if (app.accessPasswordHash && await Bun.password.verify(password, app.accessPasswordHash)) {
      const session = createAppAccessToken({
        appId: app.appId,
        kind: 'password',
        revision: app.accessRevision,
        expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      }, secret);
      const location = safeAppReturnTo(String(form?.get('return_to') ?? '/'));
      return new Response(null, {
        status: 303,
        headers: {
          location,
          'set-cookie': appAccessCookie(session, 8 * 60 * 60, localHttp),
        },
      });
    }
    return appAccessResponse(
      request,
      app,
      true,
      safeAppReturnTo(String(form?.get('return_to') ?? '/')),
    );
  }
  return appAccessResponse(request, app);
}

export interface ResolvedAppHost {
  routeKey: string;
  local: boolean;
}

export interface ResolvedAppRequest extends ResolvedAppHost {
  publicHost: string;
}

export function resolveAppHost(hostname: string): ResolvedAppHost | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const local = /^([a-f0-9]{16})\.apps\.localhost$/.exec(host);
  if (local) return { routeKey: local[1]!, local: true };
  const domain = (process.env.KORTIX_APPS_BASE_DOMAIN || 'apps.kortix.com')
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, -(domain.length + 1));
  if (label.includes('.')) return null;
  const match = /^(dev|staging|prod|preview)-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-([a-f0-9]{16})$/.exec(label);
  if (!match || match[1] !== config.INTERNAL_KORTIX_ENV) return null;
  return { routeKey: match[2]!, local: false };
}

export function resolveAppRequest(request: Request, url: URL): ResolvedAppRequest | null {
  const publicHost = (request.headers.get(EDGE_HOST_HEADER) || url.hostname)
    .toLowerCase()
    .replace(/\.$/, '');
  const matched = resolveAppHost(publicHost);
  return matched ? { ...matched, publicHost } : null;
}

function edgeSecret(): string {
  return process.env.KORTIX_APPS_EDGE_SECRET || config.API_KEY_SECRET;
}

export function appEdgeSignature(
  timestamp: string,
  host: string,
  method: string,
  pathAndQuery: string,
  secret = edgeSecret(),
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${host.toLowerCase()}\n${method.toUpperCase()}\n${pathAndQuery}`)
    .digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyAppEdgeRequest(
  request: Request,
  url: URL,
  local: boolean,
  publicHost = url.hostname,
): boolean {
  if (local && (process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE !== 'false')) return true;
  if (process.env.KORTIX_APPS_ALLOW_DIRECT_EDGE === 'true') return true;
  const host = request.headers.get(EDGE_HOST_HEADER);
  const timestamp = request.headers.get(EDGE_TIMESTAMP_HEADER);
  const signature = request.headers.get(EDGE_SIGNATURE_HEADER);
  if (!host || !timestamp || !signature) return false;
  if (host.toLowerCase() !== publicHost.toLowerCase()) return false;
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > EDGE_MAX_SKEW_MS) return false;
  return safeEqual(
    signature,
    appEdgeSignature(timestamp, host, request.method, `${url.pathname}${url.search}`),
  );
}

export async function loadPublicAppState(routeKey: string) {
  const [loaded] = await db
    .select({ app: apps, workspaceMetadata: projects.metadata })
    .from(apps)
    .innerJoin(projects, eq(projects.workspaceId, apps.workspaceId))
    .where(and(eq(apps.routeKey, routeKey), isNull(apps.deletedAt)))
    .limit(1);
  const app = loaded?.app;
  if (!loaded || !resolveFeatureFlag(loaded.workspaceMetadata, 'apps')) return null;
  if (!app) return null;
  let [deployment] = app.activeDeploymentId
    ? await db.select().from(appDeployments)
        .where(eq(appDeployments.deploymentId, app.activeDeploymentId)).limit(1)
    : [];
  if (!deployment) {
    [deployment] = await db.select().from(appDeployments)
      .where(eq(appDeployments.appId, app.appId))
      .orderBy(desc(appDeployments.createdAt))
      .limit(1);
  }
  const [runtime] = deployment?.status === 'ready'
    ? await db.select().from(appRuntimes)
        .where(eq(appRuntimes.deploymentId, deployment.deploymentId))
        .orderBy(desc(appRuntimes.createdAt)).limit(1)
    : [];
  return { app, deployment: deployment ?? null, runtime: runtime ?? null };
}

export async function loadPublicApp(routeKey: string) {
  const state = await loadPublicAppState(routeKey);
  if (
    !state?.app.activeDeploymentId ||
    state.deployment?.deploymentId !== state.app.activeDeploymentId ||
    state.deployment.status !== 'ready' ||
    !state.runtime
  ) return null;
  return { app: state.app, deployment: state.deployment, runtime: state.runtime };
}

async function waitForWake(runtimeId: string, deadline: number) {
  while (Date.now() < deadline) {
    const [runtime] = await db
      .select()
      .from(appRuntimes)
      .where(eq(appRuntimes.runtimeId, runtimeId))
      .limit(1);
    if (!runtime) throw new Error('App runtime disappeared while waking');
    if (runtime.status === 'running') return runtime;
    if (
      runtime.status === 'stopped' &&
      (!runtime.wakeLeaseUntil || runtime.wakeLeaseUntil.getTime() <= Date.now())
    ) {
      throw new Error('App wake lease ended before readiness');
    }
    if (runtime.status === 'error' || runtime.status === 'deleted') {
      throw new Error(`App runtime cannot wake from ${runtime.status}`);
    }
    await Bun.sleep(250);
  }
  throw new Error('App cold start timed out');
}

export function appRuntimeNeedsWake(
  runtime: Pick<typeof appRuntimes.$inferSelect, 'status' | 'idleDeadlineAt'>,
  now = new Date(),
): boolean {
  if (runtime.status !== 'running') return true;
  return Boolean(runtime.idleDeadlineAt && runtime.idleDeadlineAt.getTime() <= now.getTime());
}

export async function ensureAppRuntimeRunning(
  loaded: NonNullable<Awaited<ReturnType<typeof loadPublicApp>>>,
  hosting: AppHostingProvider,
  options: { forceProviderStart?: boolean } = {},
) {
  let app = loaded.app;
  if (app.desiredState !== 'running') {
    const [reactivated] = await db
      .update(apps)
      .set({ desiredState: 'running', updatedAt: new Date() })
      .where(and(eq(apps.appId, app.appId), isNull(apps.deletedAt)))
      .returning();
    if (!reactivated) throw new Error('App no longer exists');
    app = reactivated;
  }
  if (!appRuntimeNeedsWake(loaded.runtime)) return loaded.runtime;
  if (loaded.runtime.status === 'deleted') {
    throw new Error('App runtime cannot wake from deleted');
  }
  await assertAppBudgetAvailable(app.appId, Number(app.monthlyBudgetUsd));

  const owner = `${config.INTERNAL_KORTIX_ENV}:${process.pid}:${randomUUID()}`;
  const now = new Date();
  const [leased] = await db
    .update(appRuntimes)
    .set({
      status: 'starting',
      wakeLeaseOwner: owner,
      wakeLeaseUntil: new Date(now.getTime() + WAKE_LEASE_MS),
      updatedAt: now,
    })
    .where(and(
      eq(appRuntimes.runtimeId, loaded.runtime.runtimeId),
      or(isNull(appRuntimes.wakeLeaseUntil), lt(appRuntimes.wakeLeaseUntil, now)),
    ))
    .returning();
  if (!leased) return waitForWake(loaded.runtime.runtimeId, Date.now() + WAKE_LEASE_MS);

  try {
    const provider = leased.provider as SandboxProviderName;
    if (options.forceProviderStart) await hosting.start(provider, leased.externalId);
    else await hosting.ensureRunning(provider, leased.externalId);
    await hosting.waitUntilReady(provider, leased.externalId, leased.runtimeId, 120_000);

    // A manual stop can win while the provider is starting. The desired state
    // is authoritative. Do not publish a running row after the user stopped it.
    const [currentApp] = await db
      .select({ desiredState: apps.desiredState, deletedAt: apps.deletedAt })
      .from(apps)
      .where(eq(apps.appId, app.appId))
      .limit(1);
    if (!currentApp || currentApp.deletedAt || currentApp.desiredState !== 'running') {
      await hosting.stop(provider, leased.externalId);
      const stoppedAt = new Date();
      await db
        .update(appRuntimes)
        .set({
          status: 'stopped',
          stoppedAt,
          activityLeaseUntil: null,
          idleDeadlineAt: null,
          wakeLeaseOwner: null,
          wakeLeaseUntil: null,
          updatedAt: stoppedAt,
        })
        .where(and(
          eq(appRuntimes.runtimeId, leased.runtimeId),
          eq(appRuntimes.wakeLeaseOwner, owner),
        ));
      await pauseComputeSession(leased.runtimeId, stoppedAt);
      throw appWakeSupersededResponse();
    }

    const readyAt = new Date();
    const [running] = await db
      .update(appRuntimes)
      .set({
        status: 'running',
        startedAt: readyAt,
        stoppedAt: null,
        wakeLeaseOwner: null,
        wakeLeaseUntil: null,
        idleDeadlineAt: new Date(readyAt.getTime() + app.idleTimeoutSeconds * 1000),
        updatedAt: readyAt,
      })
      .where(and(
        eq(appRuntimes.runtimeId, leased.runtimeId),
        eq(appRuntimes.wakeLeaseOwner, owner),
      ))
      .returning();
    if (!running) throw new Error('App wake lease was lost after provider start');
    await startComputeSession({
      sandboxId: running.runtimeId,
      accountId: running.accountId,
      provider,
      spec: {
        cpuCores: app.cpuCores,
        memoryGb: app.memoryGb,
        diskGb: app.diskGb,
        gpuCount: 0,
      },
      workloadType: 'app',
      appRuntimeId: running.runtimeId,
      metadata: { appId: app.appId, deploymentId: loaded.deployment.deploymentId },
    });
    return running;
  } catch (error) {
    const stoppedAt = new Date();
    await db
      .update(appRuntimes)
      .set({
        status: 'stopped',
        stoppedAt,
        activityLeaseUntil: null,
        idleDeadlineAt: null,
        wakeLeaseOwner: null,
        wakeLeaseUntil: null,
        updatedAt: stoppedAt,
      })
      .where(and(
        eq(appRuntimes.runtimeId, loaded.runtime.runtimeId),
        eq(appRuntimes.wakeLeaseOwner, owner),
      ));
    await pauseComputeSession(loaded.runtime.runtimeId, stoppedAt).catch(() => {});
    throw error;
  }
}

export function appUpstreamHeaders(request: Request, providerHeaders: Record<string, string>, publicHost: string): Headers {
  const headers = new Headers(request.headers);
  for (const name of [
    'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    EDGE_HOST_HEADER, EDGE_TIMESTAMP_HEADER, EDGE_SIGNATURE_HEADER,
  ]) headers.delete(name);
  headers.set('x-kortix-app-host', publicHost);
  headers.set('x-forwarded-host', publicHost);
  headers.set('x-forwarded-proto', 'https');
  // Bun fetch transparently decodes compressed upstream bodies but preserves
  // the upstream Content-Encoding header. Request identity bytes so the public
  // client never attempts to decode an already-decoded body a second time.
  headers.set('accept-encoding', 'identity');
  for (const [name, value] of Object.entries(providerHeaders)) headers.set(name, value);
  return headers;
}

function withoutFrameAncestors(value: string): string[] {
  return value
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive));
}

/** Preserve App security policy while allowing the Kortix preview browser to frame it. */
export function appPublicResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete('x-frame-options');

  const enforced = withoutFrameAncestors(headers.get('content-security-policy') || '');
  headers.set('content-security-policy', [...enforced, APP_FRAME_ANCESTORS].join('; '));

  const reportOnlyKey = 'content-security-policy-report-only';
  const reportOnly = headers.get(reportOnlyKey);
  if (reportOnly && /frame-ancestors/i.test(reportOnly)) {
    const remaining = withoutFrameAncestors(reportOnly);
    if (remaining.length) headers.set(reportOnlyKey, remaining.join('; '));
    else headers.delete(reportOnlyKey);
  }
  return headers;
}

export async function handleAppPublicRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const matched = resolveAppRequest(request, url);
  if (!matched) return null;
  if (!verifyAppEdgeRequest(request, url, matched.local, matched.publicHost)) {
    return Response.json({ error: 'Invalid App edge signature' }, { status: 403 });
  }
  const state = await loadPublicAppState(matched.routeKey);
  if (!state) return Response.json({ error: 'App not found' }, { status: 404 });
  const accessResponse = await authorizeAppRequest(request, url, state.app);
  if (accessResponse) return accessResponse;
  if (
    !state.app.activeDeploymentId ||
    state.deployment?.deploymentId !== state.app.activeDeploymentId ||
    state.deployment.status !== 'ready' ||
    !state.runtime
  ) {
    return appPublicStatusResponse(request, state.app, publicDeploymentStatus(state.deployment));
  }
  const loaded = { app: state.app, deployment: state.deployment, runtime: state.runtime };
  const hosting = new AppHostingProvider();
  const coldStart = appRuntimeNeedsWake(state.runtime);
  if (coldStart) {
    await enqueueCurrentAppRuntime(state.app, state.deployment).catch((error) => {
      console.warn(`[apps] runtime refresh queue failed for ${state.app.appId}:`, error);
    });
  }
  let runtime: typeof loaded.runtime;
  try {
    runtime = await ensureAppRuntimeRunning(loaded, hosting);
  } catch (error) {
    if (error instanceof AppBudgetExceededError) return appPublicBudgetResponse(request, state.app);
    return appPublicUnavailableResponse(request, state.app);
  }
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + ACTIVITY_LEASE_MS);
  await Promise.all([
    db.update(apps).set({ lastRequestAt: now, updatedAt: now }).where(eq(apps.appId, loaded.app.appId)),
    db.update(appRuntimes).set({
      lastRequestAt: now,
      activityLeaseUntil: leaseUntil,
      idleDeadlineAt: new Date(now.getTime() + loaded.app.idleTimeoutSeconds * 1000),
      updatedAt: now,
    }).where(eq(appRuntimes.runtimeId, runtime.runtimeId)),
    markComputeSessionAlive(runtime.runtimeId, now),
  ]);

  const replayableRequest = request.method === 'GET' || request.method === 'HEAD';
  const fetchUpstream = async () => {
    const ingress = await hosting.ingress(runtime.provider as SandboxProviderName, runtime.externalId);
    const upstreamUrl = `${ingress.url.replace(/\/$/, '')}${url.pathname}${url.search}`;
    return fetch(upstreamUrl, {
      method: request.method,
      headers: appUpstreamHeaders(request, ingress.headers, matched.publicHost),
      body: replayableRequest ? undefined : request.body,
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit);
  };
  const recoverProviderRuntime = async (forceProviderStart: boolean) => {
    runtime = await ensureAppRuntimeRunning({
      ...loaded,
      runtime: {
        ...runtime,
        status: 'stopped',
        idleDeadlineAt: null,
      },
    }, hosting, { forceProviderStart });
  };
  const startingResponse = async () => {
    await db.update(appRuntimes).set({ activityLeaseUntil: null, updatedAt: new Date() })
      .where(eq(appRuntimes.runtimeId, runtime.runtimeId));
    return appPublicUnavailableResponse(request, state.app);
  };

  let upstream: Response;
  let recoveredProvider = false;
  try {
    upstream = await fetchUpstream();
  } catch {
    try {
      await recoverProviderRuntime(false);
      recoveredProvider = true;
      if (!replayableRequest) return startingResponse();
      upstream = await fetchUpstream();
    } catch {
      return startingResponse();
    }
  }

  if (upstream.status === 400) {
    const body = await upstream.clone().text().catch(() => '');
    if (appProviderStoppedResponse(runtime.provider as SandboxProviderName, upstream.status, body)) {
      await upstream.body?.cancel().catch(() => {});
      if (coldStart) return startingResponse();
      try {
        await recoverProviderRuntime(true);
        recoveredProvider = true;
        if (!replayableRequest) return startingResponse();
        upstream = await fetchUpstream();
      } catch {
        return startingResponse();
      }
      if (upstream.status === 400) {
        const retryBody = await upstream.clone().text().catch(() => '');
        if (appProviderStoppedResponse(runtime.provider as SandboxProviderName, upstream.status, retryBody)) {
          await upstream.body?.cancel().catch(() => {});
          return startingResponse();
        }
      }
    }
  }

  const coldStartResponse = appColdStartUpstreamResponse(
    request,
    state.app,
    coldStart || recoveredProvider,
    upstream.status,
  );
  if (coldStartResponse) {
    await upstream.body?.cancel().catch(() => {});
    await db.update(appRuntimes).set({ activityLeaseUntil: null, updatedAt: new Date() })
      .where(eq(appRuntimes.runtimeId, runtime.runtimeId));
    return coldStartResponse;
  }

  const responseHeaders = appPublicResponseHeaders(upstream.headers);
  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
    responseHeaders.delete(name);
  }
  if (!upstream.body || request.method === 'HEAD') {
    await db.update(appRuntimes).set({ activityLeaseUntil: null, updatedAt: new Date() })
      .where(eq(appRuntimes.runtimeId, runtime.runtimeId));
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const renew = setInterval(() => {
    const at = new Date();
    void Promise.all([
      db.update(appRuntimes).set({
        activityLeaseUntil: new Date(at.getTime() + ACTIVITY_LEASE_MS),
        idleDeadlineAt: new Date(at.getTime() + loaded.app.idleTimeoutSeconds * 1000),
        updatedAt: at,
      }).where(eq(appRuntimes.runtimeId, runtime.runtimeId)),
      markComputeSessionAlive(runtime.runtimeId, at),
    ]);
  }, 30_000);
  void upstream.body
    .pipeTo(stream.writable)
    // Browser navigation can cancel the response during a refresh. The client
    // already owns that failure, so consume it instead of emitting an
    // unhandled rejection from this fire-and-forget stream.
    .catch(() => {})
    .finally(() => {
      clearInterval(renew);
      void db.update(appRuntimes).set({ activityLeaseUntil: null, updatedAt: new Date() })
        .where(eq(appRuntimes.runtimeId, runtime.runtimeId));
    });
  return new Response(stream.readable, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
