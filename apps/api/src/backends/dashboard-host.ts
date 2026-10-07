/**
 * The Convex dashboard of one backend, served on a Kortix hostname so Kortix
 * web can frame it.
 *
 * Every backend machine serves Convex's own dashboard (a static export,
 * version-matched to the backend) on CONVEX_DASHBOARD_PORT. Platinum's edge
 * refuses to let anything but platinum.dev frame its hosts, so Kortix proxies
 * the dashboard's files through a host of its own:
 *
 *   local:  http://bd-<backend id, 32 hex>.apps.localhost:<api port>
 *   remote: https://<env>-backend-<backend id, 32 hex>.<apps base domain>
 *
 * The remote shape reuses the Apps wildcard domain, its Cloudflare router
 * (which signs the request and sets frame-ancestors to Kortix) and its
 * self-host on-demand TLS gate. It cannot collide with an App host: an App
 * host ends in `-<16 hex>`, this one in 32 hex with no dash before it.
 *
 * The files are public and hold no data. The dashboard learns the deployment
 * URL and admin key only from the framing Kortix page (Convex's postMessage
 * handshake), which reads them through the audited credentials route.
 */
import { projectBackends } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { appsBaseDomain, appsLocalMode, appsLocalUrl } from '../apps/hostnames';
import { edgePublicHost, verifyAppEdgeRequest } from '../apps/public-proxy-edge';
import { db } from '../shared/db';
import { CONVEX_DASHBOARD_PORT } from './convex-image';
import type { BackendRow } from './provision';

const LOCAL_HOST = /^bd-([a-f0-9]{32})\.apps\.localhost$/;
const REMOTE_LABEL = /^(dev|staging|prod|preview)-backend-([a-f0-9]{32})$/;
const PASS_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-length'];
const UPSTREAM_TIMEOUT_MS = 20_000;

const compact = (id: string) => id.replaceAll('-', '');
const expand = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** The backend id a dashboard hostname names, or null for any other host. */
export function resolveBackendDashboardHost(hostname: string): { backendId: string; local: boolean } | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  // Only a local stack answers local hosts: elsewhere a caller could name one
  // in the edge host header and skip the edge signature.
  const local = appsLocalMode() ? LOCAL_HOST.exec(host) : null;
  if (local) return { backendId: expand(local[1]!), local: true };
  const domain = appsBaseDomain();
  if (!domain || !host.endsWith(`.${domain}`)) return null;
  const match = REMOTE_LABEL.exec(host.slice(0, -(domain.length + 1)));
  if (!match || match[1] !== config.INTERNAL_KORTIX_ENV) return null;
  return { backendId: expand(match[2]!), local: false };
}

function dashboardOrigin(backendId: string): string | null {
  if (appsLocalMode()) return appsLocalUrl(`bd-${compact(backendId)}`);
  const domain = appsBaseDomain();
  return domain ? `https://${config.INTERNAL_KORTIX_ENV}-backend-${compact(backendId)}.${domain}` : null;
}

/** The dashboard URL Kortix web frames, or null for a machine built before the dashboard shipped. */
export function backendDashboardUrl(row: BackendRow): string | null {
  if (row.status !== 'running' || !row.url || !(row.metadata as { dashboard?: boolean }).dashboard) return null;
  return dashboardOrigin(row.backendId);
}

/** Platinum exposes each port at https://<port>-<sandbox>.<region>…; the API port is the stored URL. */
function upstreamOrigin(row: BackendRow): string {
  return row.url!.replace(/^https:\/\/\d+-/, `https://${CONVEX_DASHBOARD_PORT}-`);
}

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function backendDashboardTlsCheckStatus(domain: string | null | undefined): Promise<200 | 403 | 404> {
  const matched = domain ? resolveBackendDashboardHost(domain) : null;
  if (!matched) return 403;
  if (matched.local) return 200;
  const [row] = await db
    .select({ id: projectBackends.backendId })
    .from(projectBackends)
    .where(and(eq(projectBackends.backendId, matched.backendId), isNull(projectBackends.deletedAt)))
    .limit(1);
  return row ? 200 : 404;
}

/** Answers a request on a dashboard host, or null when the host is not one. */
export async function handleBackendDashboardRequest(req: Request, url: URL): Promise<Response | null> {
  const publicHost = edgePublicHost(req, url);
  const matched = resolveBackendDashboardHost(publicHost);
  if (!matched) return null;
  if (!verifyAppEdgeRequest(req, url, matched.local, publicHost)) return plain(403, 'Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');

  const [row] = await db
    .select()
    .from(projectBackends)
    .where(and(eq(projectBackends.backendId, matched.backendId), isNull(projectBackends.deletedAt)))
    .limit(1);
  if (!row || !backendDashboardUrl(row)) return plain(404, 'No dashboard for this backend');

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamOrigin(row)}${url.pathname}${url.search}`, {
      method: req.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return new Response('The backend is starting. Retry in a few seconds.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3' },
    });
  }
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('content-security-policy', `frame-ancestors ${new URL(config.FRONTEND_URL).origin}`);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(req.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}
