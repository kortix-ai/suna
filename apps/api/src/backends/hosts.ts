/**
 * The Kortix hostnames of a backend. Every backend answers on three hosts
 * under the Apps domain, derived from its backend id, so they never change
 * for the backend's life (a restore, a resize or a new machine keeps them):
 *
 *   kind       remote (https)                              local (http, API port)        machine port
 *   api        <env>-convex-<id hex>.<apps domain>         bc-<id hex>.apps.localhost    3210  Convex client, sync WebSocket, admin API
 *   site       <env>-convex-site-<id hex>.<apps domain>    bs-<id hex>.apps.localhost    3211  HTTP actions
 *   dashboard  <env>-backend-<id hex>.<apps domain>        bd-<id hex>.apps.localhost    6791  Convex's dashboard files
 *
 * `<id hex>` is the backend id without dashes (32 hex). The remote shape reuses
 * the Apps wildcard domain, its Cloudflare router (which signs each request,
 * WebSocket upgrades included) and its self-host on-demand TLS gate. None can
 * collide with an App host: an App host ends in `-<16 hex>`, these in 32 hex
 * with no dash before the last 16.
 *
 * The Kortix API proxies every host to the machine through Platinum's PRIVATE
 * exposure (./machine.ts): the machine's own Platinum URL refuses a request
 * without Kortix's token. The api and site hosts pass every method, stream
 * bodies both ways, and upgrade WebSockets. Convex authenticates the caller
 * itself (admin key, member token), exactly as on Convex Cloud: these hosts
 * are public URLs.
 *
 * The dashboard host serves static files only (GET/HEAD) and lets only Kortix
 * web frame them. The dashboard learns the deployment URL and admin key from
 * the framing Kortix page (Convex's postMessage handshake), which reads them
 * through the audited credentials route.
 */
import { projectBackends } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { appsBaseDomain, appsLocalMode, appsLocalUrl } from '../apps/hostnames';
import { edgePublicHost, verifyAppEdgeRequest } from '../apps/public-proxy-edge';
import { appUpstreamHeaders } from '../apps/public-proxy-headers';
import { ingressTargetUrl } from '../platform/providers/ingress-url';
import type { PreviewWsData } from '../sandbox-proxy/ws-proxy';
import { db } from '../shared/db';
import { CONVEX_API_PORT, CONVEX_DASHBOARD_PORT, CONVEX_SITE_PORT } from './convex-image';
import { backendIngress, machineFetch } from './machine';
import type { BackendRow } from './provision';

export type BackendHostKind = 'api' | 'site' | 'dashboard';

const KINDS: Record<BackendHostKind, { local: string; remote: string; port: number }> = {
  api: { local: 'bc', remote: 'convex', port: CONVEX_API_PORT },
  site: { local: 'bs', remote: 'convex-site', port: CONVEX_SITE_PORT },
  dashboard: { local: 'bd', remote: 'backend', port: CONVEX_DASHBOARD_PORT },
};
const LOCAL_HOST = /^(bc|bs|bd)-([a-f0-9]{32})\.apps\.localhost$/;
const REMOTE_LABEL = /^(dev|staging|prod|preview)-(convex-site|convex|backend)-([a-f0-9]{32})$/;
const KIND_OF_LABEL = Object.fromEntries(
  (Object.keys(KINDS) as BackendHostKind[]).flatMap((kind) => [
    [KINDS[kind].local, kind],
    [KINDS[kind].remote, kind],
  ]),
) as Record<string, BackendHostKind>;
const DASHBOARD_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-length'];
const DASHBOARD_TIMEOUT_MS = 20_000;
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'];

const compact = (id: string) => id.replaceAll('-', '');
const expand = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export interface ResolvedBackendHost {
  backendId: string;
  kind: BackendHostKind;
  local: boolean;
}

/** The backend and kind a hostname names, or null for any other host. */
export function resolveBackendHost(hostname: string): ResolvedBackendHost | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  // Only a local stack answers local hosts: elsewhere a caller could name one
  // in the edge host header and skip the edge signature.
  const local = appsLocalMode() ? LOCAL_HOST.exec(host) : null;
  if (local) return { backendId: expand(local[2]!), kind: KIND_OF_LABEL[local[1]!]!, local: true };
  const domain = appsBaseDomain();
  if (!domain || !host.endsWith(`.${domain}`)) return null;
  const match = REMOTE_LABEL.exec(host.slice(0, -(domain.length + 1)));
  if (!match || match[1] !== config.INTERNAL_KORTIX_ENV) return null;
  return { backendId: expand(match[3]!), kind: KIND_OF_LABEL[match[2]!]!, local: false };
}

/** The origin of one of a backend's hosts, or null when this deployment has no Apps domain. */
export function backendHostUrl(backendId: string, kind: BackendHostKind): string | null {
  if (appsLocalMode()) return appsLocalUrl(`${KINDS[kind].local}-${compact(backendId)}`);
  const domain = appsBaseDomain();
  return domain ? `https://${config.INTERNAL_KORTIX_ENV}-${KINDS[kind].remote}-${compact(backendId)}.${domain}` : null;
}

/** The backend's Convex URL (`url`) and HTTP actions URL (`site_url`). */
export function backendPublicUrls(backendId: string): { url: string; siteUrl: string } {
  const url = backendHostUrl(backendId, 'api');
  const siteUrl = backendHostUrl(backendId, 'site');
  if (!url || !siteUrl) {
    throw new Error('Kortix Backends has no host domain: set KORTIX_APPS_BASE_DOMAIN to a wildcard domain this deployment serves.');
  }
  return { url, siteUrl };
}

/** The dashboard URL Kortix web frames, or null for a machine built before the dashboard shipped. */
export function backendDashboardUrl(row: BackendRow): string | null {
  if (row.status !== 'running' || !row.url || !(row.metadata as { dashboard?: boolean }).dashboard) return null;
  return backendHostUrl(row.backendId, 'dashboard');
}

function plain(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

const starting = () => plain(503, 'The backend is starting. Retry in a few seconds.', { 'retry-after': '3' });

async function liveBackend(backendId: string): Promise<BackendRow | null> {
  const [row] = await db
    .select()
    .from(projectBackends)
    .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function backendHostTlsCheckStatus(domain: string | null | undefined): Promise<200 | 403 | 404> {
  const matched = domain ? resolveBackendHost(domain) : null;
  if (!matched) return 403;
  if (matched.local) return 200;
  return (await liveBackend(matched.backendId)) ? 200 : 404;
}

export interface BackendHostRequest extends ResolvedBackendHost {
  publicHost: string;
}

/** The backend host a request targets (by the edge-signed host header, as for Apps), or null. */
export function resolveBackendRequest(req: Request, url: URL): BackendHostRequest | null {
  const publicHost = edgePublicHost(req, url);
  const matched = resolveBackendHost(publicHost);
  return matched ? { ...matched, publicHost } : null;
}

/** A running backend with a machine, or the response that explains why not. */
async function runningMachine(backendId: string): Promise<{ row: BackendRow; externalId: string } | Response> {
  const row = await liveBackend(backendId);
  if (!row) return plain(404, 'No such backend');
  if (row.status === 'provisioning' && !row.externalId) return starting();
  if (row.status !== 'running' || !row.externalId) return plain(503, `The backend is ${row.status}.`);
  return { row, externalId: row.externalId };
}

/** Answers a request on a backend host. The caller matched the host with resolveBackendRequest. */
export async function handleBackendHostRequest(req: Request, url: URL, matched: BackendHostRequest): Promise<Response> {
  if (!verifyAppEdgeRequest(req, url, matched.local, matched.publicHost)) return plain(403, 'Forbidden');
  if (matched.kind === 'dashboard') return dashboardResponse(req, url, matched.backendId);
  const machine = await runningMachine(matched.backendId);
  if (machine instanceof Response) return machine;
  const bodyless = req.method === 'GET' || req.method === 'HEAD';
  let upstream: Response;
  try {
    upstream = await machineFetch(machine.externalId, KINDS[matched.kind].port, `${url.pathname}${url.search}`, {
      method: req.method,
      // The client's headers minus hop-by-hop, edge and Kortix credential headers, as for an App.
      headers: appUpstreamHeaders(req, {}, matched.publicHost),
      body: bodyless ? undefined : req.body,
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit);
  } catch {
    return starting();
  }
  const headers = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  // Platinum's edge stamps its own headers; the client sees Kortix and Convex only.
  for (const name of [...headers.keys()]) if (name.startsWith('x-pt-')) headers.delete(name);
  for (const name of ['via', 'alt-svc']) headers.delete(name);
  if (/platinum\.dev/.test(headers.get('content-security-policy') ?? '')) headers.delete('content-security-policy');
  return new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function dashboardResponse(req: Request, url: URL, backendId: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');
  const row = await liveBackend(backendId);
  if (!row?.externalId || !backendDashboardUrl(row)) return plain(404, 'No dashboard for this backend');
  let upstream: Response;
  try {
    upstream = await machineFetch(row.externalId, CONVEX_DASHBOARD_PORT, `${url.pathname}${url.search}`, {
      method: req.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
    });
  } catch {
    return starting();
  }
  const headers = new Headers();
  for (const name of DASHBOARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('content-security-policy', `frame-ancestors ${new URL(config.FRONTEND_URL).origin}`);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(req.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}

/**
 * Resolves a WebSocket upgrade on the api host (the Convex sync protocol,
 * `/api/<version>/sync`). The upgraded pair is piped by the sandbox preview
 * WebSocket handlers, which also ping both legs so no idle cut closes it.
 */
export async function prepareBackendWsUpgrade(
  req: Request,
  url: URL,
  matched: BackendHostRequest,
): Promise<{ ok: true; data: PreviewWsData } | { ok: false; status: number; message: string }> {
  if (!verifyAppEdgeRequest(req, url, matched.local, matched.publicHost)) return { ok: false, status: 403, message: 'Forbidden' };
  if (matched.kind === 'dashboard') return { ok: false, status: 404, message: 'The dashboard host has no WebSocket' };
  const machine = await runningMachine(matched.backendId);
  if (machine instanceof Response) return { ok: false, status: machine.status, message: await machine.text() };
  const port = KINDS[matched.kind].port;
  let ingress: Awaited<ReturnType<typeof backendIngress>>;
  try {
    ingress = await backendIngress(machine.externalId, port);
  } catch {
    return { ok: false, status: 503, message: 'The backend is starting. Retry in a few seconds.' };
  }
  const headers = appUpstreamHeaders(req, ingress.headers, matched.publicHost);
  // The upstream socket negotiates its own handshake and extensions.
  for (const name of [...headers.keys()]) if (name.startsWith('sec-websocket-')) headers.delete(name);
  const target = new URL(ingressTargetUrl(ingress, `${url.pathname}${url.search}`));
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    ok: true,
    data: {
      type: 'preview-ws',
      url: target.toString(),
      headers: Object.fromEntries(headers.entries()),
      ingress: { sandboxId: machine.externalId, port },
    },
  };
}
