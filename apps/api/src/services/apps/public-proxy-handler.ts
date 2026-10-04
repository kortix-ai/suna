import { appRuntimes, apps } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { markComputeSessionAlive } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../../lib/config';
import { db } from '../../lib/db';
import { ingressTargetUrl } from '../platform/providers/ingress-url';
import { AppBudgetExceededError } from './budget';
import { AppAccountUnfundedError, AppLimitError } from './limits';
import { AppHostingProvider } from './hosting';
import { enqueueCurrentAppRuntime } from './deployment-worker';
import { authorizeAppRequest, resolveAppViewerUserId, bindAppViewerSession, appViewerEndpointResponse, appViewerContextHeader } from './public-proxy-access';
import { resolveAppRequest, verifyAppEdgeRequest } from './public-proxy-edge';
import { appPublicStatusResponse, publicDeploymentStatus, appPublicBudgetResponse, appPublicUnavailableResponse, appProviderStoppedResponse, appColdStartUpstreamResponse } from './public-proxy-status';
import { loadPublicAppState, loadPublicApp, ensureAppRuntimeRunning, appRuntimeNeedsWake } from './public-proxy-runtime';
import { appUpstreamHeaders, appPublicResponseHeaders } from './public-proxy-headers';
const ACTIVITY_LEASE_MS = 60_000;
type LoadedApp = Omit<NonNullable<Awaited<ReturnType<typeof loadPublicApp>>>, 'agentPrincipal'>;

export async function handleAppPublicRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const matched = resolveAppRequest(request, url);
  if (!matched) return null;
  if (!verifyAppEdgeRequest(request, url, matched.local, matched.publicHost)) {
    return Response.json({ error: 'Invalid App edge signature' }, { status: 403 });
  }
  const state = await loadPublicAppState(matched.routeKey);
  if (!state) return Response.json({ error: 'App not found' }, { status: 404 });
  const gateApp = { ...state.app, agentPrincipal: state.agentPrincipal };
  const accessResponse = await authorizeAppRequest(request, url, gateApp);
  if (accessResponse) return accessResponse;
  const sessionViewer = resolveAppViewerUserId(request, url, gateApp);
  if (sessionViewer) bindAppViewerSession(sessionViewer);
  // Answered by the gate itself, before any runtime work: reading who you are
  // must never wake a sleeping sandbox.
  if (url.pathname === '/_kortix/viewer') {
    return appViewerEndpointResponse(request, url, gateApp);
  }
  const viewer = await appViewerContextHeader(request, url, state.app);
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
  return proxyRunningApp(request, url, matched.publicHost, viewer, loaded, hosting, coldStart);
}

async function proxyRunningApp(
  request: Request,
  url: URL,
  publicHost: string,
  viewer: Awaited<ReturnType<typeof appViewerContextHeader>>,
  loaded: LoadedApp,
  hosting: AppHostingProvider,
  coldStart: boolean,
): Promise<Response> {
  let runtime: typeof loaded.runtime;
  try {
    runtime = await ensureAppRuntimeRunning(loaded, hosting);
  } catch (error) {
    if (error instanceof AppBudgetExceededError) return appPublicBudgetResponse(request, loaded.app);
    // An unfunded account or an account at its App-concurrency cap is a paused
    // App, not a broken one. Say so instead of showing an endless spinner.
    if (error instanceof AppAccountUnfundedError) {
      return appPublicStatusResponse(request, loaded.app, { status: 'unfunded' });
    }
    if (error instanceof AppLimitError && error.code === 'app_concurrency_limit') {
      return appPublicStatusResponse(request, loaded.app, { status: 'capacity' });
    }
    return appPublicUnavailableResponse(request, loaded.app);
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
    const upstreamUrl = ingressTargetUrl(ingress, `${url.pathname}${url.search}`);
    return fetch(upstreamUrl, {
      method: request.method,
      headers: appUpstreamHeaders(request, ingress.headers, publicHost, viewer),
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
    return appPublicUnavailableResponse(request, loaded.app);
  };

  const { upstream, recoveredProvider, starting } = await fetchWithRecovery(
    fetchUpstream, recoverProviderRuntime, startingResponse, () => runtime.provider as SandboxProviderName,
    replayableRequest, coldStart,
  );
  if (starting) return starting;
  return respondFromUpstream(request, loaded, runtime, upstream, coldStart || recoveredProvider);
}

async function fetchWithRecovery(
  fetchUpstream: () => Promise<Response>,
  recoverProviderRuntime: (force: boolean) => Promise<void>,
  startingResponse: () => Promise<Response>,
  provider: () => SandboxProviderName,
  replayableRequest: boolean,
  coldStart: boolean,
): Promise<{ upstream: Response; recoveredProvider: boolean; starting?: never } | { starting: Response; upstream?: never; recoveredProvider?: never }> {
  let upstream: Response;
  let recoveredProvider = false;
  try {
    upstream = await fetchUpstream();
  } catch {
    try {
      await recoverProviderRuntime(false);
      recoveredProvider = true;
      if (!replayableRequest) return { starting: await startingResponse() };
      upstream = await fetchUpstream();
    } catch {
      return { starting: await startingResponse() };
    }
  }

  // 400 was Daytona's shape. E2B reports a dead runtime as 5xx, so the check has
  // to see those statuses or the recovery below can never run for it.
  if (upstream.status === 400 || upstream.status >= 502) {
    const body = await upstream.clone().text().catch(() => '');
    if (appProviderStoppedResponse(provider(), upstream.status, body)) {
      await upstream.body?.cancel().catch(() => {});
      if (coldStart) return { starting: await startingResponse() };
      try {
        await recoverProviderRuntime(true);
        recoveredProvider = true;
        if (!replayableRequest) return { starting: await startingResponse() };
        upstream = await fetchUpstream();
      } catch {
        return { starting: await startingResponse() };
      }
      if (upstream.status === 400 || upstream.status >= 502) {
        const retryBody = await upstream.clone().text().catch(() => '');
        if (appProviderStoppedResponse(provider(), upstream.status, retryBody)) {
          await upstream.body?.cancel().catch(() => {});
          return { starting: await startingResponse() };
        }
      }
    }
  }

  return { upstream, recoveredProvider };
}

async function respondFromUpstream(
  request: Request,
  loaded: LoadedApp,
  runtime: LoadedApp['runtime'],
  upstream: Response,
  waking: boolean,
): Promise<Response> {
  const coldStartResponse = appColdStartUpstreamResponse(
    request,
    loaded.app,
    waking,
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
