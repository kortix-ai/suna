import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  markComputeSessionAlive,
  pauseComputeSession,
  startComputeSession,
} from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { assertAppBudgetAvailable } from './budget';
import { AppHostingProvider } from './hosting';

const EDGE_HOST_HEADER = 'x-kortix-app-host';
const EDGE_TIMESTAMP_HEADER = 'x-kortix-app-timestamp';
const EDGE_SIGNATURE_HEADER = 'x-kortix-app-signature';
const EDGE_MAX_SKEW_MS = 5 * 60_000;
const WAKE_LEASE_MS = 2 * 60_000;
const ACTIVITY_LEASE_MS = 60_000;

function appStoppedResponse(): Response {
  return new Response(JSON.stringify({ error: 'App is stopped', code: 'app_stopped' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': '60' },
  });
}

export function appPublicUnavailableResponse(): Response {
  return Response.json(
    { error: 'App is temporarily unavailable', code: 'app_unavailable' },
    { status: 503, headers: { 'retry-after': '5' } },
  );
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

export async function loadPublicApp(routeKey: string) {
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.routeKey, routeKey), isNull(apps.deletedAt)))
    .limit(1);
  if (!app || !app.activeDeploymentId) return null;
  const [deployment] = await db
    .select()
    .from(appDeployments)
    .where(and(
      eq(appDeployments.deploymentId, app.activeDeploymentId),
      eq(appDeployments.status, 'ready'),
    ))
    .limit(1);
  if (!deployment) return null;
  const [runtime] = await db
    .select()
    .from(appRuntimes)
    .where(eq(appRuntimes.deploymentId, deployment.deploymentId))
    .orderBy(desc(appRuntimes.createdAt))
    .limit(1);
  return runtime ? { app, deployment, runtime } : null;
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
      throw appStoppedResponse();
    }
    if (runtime.status === 'error' || runtime.status === 'deleted') {
      throw new Error(`App runtime cannot wake from ${runtime.status}`);
    }
    await Bun.sleep(250);
  }
  throw new Error('App cold start timed out');
}

export async function ensureAppRuntimeRunning(
  loaded: NonNullable<Awaited<ReturnType<typeof loadPublicApp>>>,
  hosting: AppHostingProvider,
) {
  if (loaded.app.desiredState !== 'running') {
    throw appStoppedResponse();
  }
  if (loaded.runtime.status === 'running') return loaded.runtime;
  if (loaded.runtime.status === 'deleted') {
    throw new Error('App runtime cannot wake from deleted');
  }
  await assertAppBudgetAvailable(loaded.app.appId, Number(loaded.app.monthlyBudgetUsd));

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
    await hosting.ensureRunning(provider, leased.externalId);
    await hosting.waitUntilReady(provider, leased.externalId, leased.runtimeId, 120_000);

    // A manual stop can win while the provider is starting. The desired state
    // is authoritative. Do not publish a running row after the user stopped it.
    const [currentApp] = await db
      .select({ desiredState: apps.desiredState, deletedAt: apps.deletedAt })
      .from(apps)
      .where(eq(apps.appId, loaded.app.appId))
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
      throw appStoppedResponse();
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
        idleDeadlineAt: new Date(readyAt.getTime() + loaded.app.idleTimeoutSeconds * 1000),
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
        cpuCores: loaded.app.cpuCores,
        memoryGb: loaded.app.memoryGb,
        diskGb: loaded.app.diskGb,
        gpuCount: 0,
      },
      workloadType: 'app',
      appRuntimeId: running.runtimeId,
      metadata: { appId: loaded.app.appId, deploymentId: loaded.deployment.deploymentId },
    });
    return running;
  } catch (error) {
    await db
      .update(appRuntimes)
      .set({ status: 'error', wakeLeaseOwner: null, wakeLeaseUntil: null, updatedAt: new Date() })
      .where(and(
        eq(appRuntimes.runtimeId, loaded.runtime.runtimeId),
        eq(appRuntimes.wakeLeaseOwner, owner),
      ));
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

export async function handleAppPublicRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const matched = resolveAppRequest(request, url);
  if (!matched) return null;
  if (!verifyAppEdgeRequest(request, url, matched.local, matched.publicHost)) {
    return Response.json({ error: 'Invalid App edge signature' }, { status: 403 });
  }
  const loaded = await loadPublicApp(matched.routeKey);
  if (!loaded) return Response.json({ error: 'App not found' }, { status: 404 });
  const hosting = new AppHostingProvider();
  let runtime;
  try {
    runtime = await ensureAppRuntimeRunning(loaded, hosting);
  } catch (error) {
    if (error instanceof Response) return error;
    return appPublicUnavailableResponse();
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

  const ingress = await hosting.ingress(runtime.provider as SandboxProviderName, runtime.externalId);
  const upstreamUrl = `${ingress.url.replace(/\/$/, '')}${url.pathname}${url.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: appUpstreamHeaders(request, ingress.headers, matched.publicHost),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit);
  } catch {
    return Response.json(
      { error: 'App upstream is unavailable', code: 'app_upstream_unavailable' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers(upstream.headers);
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
  void upstream.body.pipeTo(stream.writable).finally(() => {
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
