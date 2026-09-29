import { Hono } from 'hono';
import {
  PUBLIC_SHARE_BLOCKED_PORTS,
  PUBLIC_SHARE_VIEW_METHODS,
  STATIC_FILE_SHARE_PORT,
  resolvePublicShare,
  resourceProxyPath,
  touchPublicShare,
  transcriptShareViewerUrl,
} from '../../shared/session-public-shares';
import { previewOriginFor } from '../preview-hosts';
import { forwardToSandbox, stripFrameAncestors } from './preview';

const publicShareApp = new Hono();

/**
 * The path form serves share-author content on the API origin. That origin
 * carries the viewer's `__preview_session` cookie (`Path=/v1/p/`) and shares a
 * registrable domain with the web app, so author content must not act as the
 * API origin:
 *   - `Content-Security-Policy: sandbox` without `allow-same-origin` runs the
 *     document in an opaque origin. Its script cannot read same-origin API
 *     responses, and the browser sends it no API cookies.
 *   - `Set-Cookie` is dropped. A cookie set here would land on the API host,
 *     or, with a `Domain` attribute, on the web app.
 * The preview origin (`preview-origin.ts`) is the full-fidelity home of a
 * shared app; document navigations are redirected there when this deployment
 * has one (`previewNavigationRedirect`).
 */
export const PUBLIC_SHARE_SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

export function publicResponseHeaders(upstreamHeaders: Headers, origin: string): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete('set-cookie');
  headers.delete('x-frame-options');
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    const csp = headers.get(key);
    if (csp && /frame-ancestors/i.test(csp)) {
      const next = stripFrameAncestors(csp);
      if (next) headers.set(key, next);
      else headers.delete(key);
    }
  }
  // Appended, not set: multiple CSP headers are all enforced, so the author's
  // own policy still applies alongside the sandbox.
  headers.append('Content-Security-Policy', PUBLIC_SHARE_SANDBOX_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'false');
  }
  return headers;
}

/**
 * A browser navigating to the path form goes to the share's preview origin
 * instead, when this deployment has a preview domain. The path form stays for
 * programmatic clients and for a self-host without a preview domain.
 */
export function previewNavigationRedirect(input: {
  method: string;
  fetchDest: string | undefined;
  previewOrigin: string | null;
  path: string;
  search: string;
  token: string;
}): string | null {
  if (!input.previewOrigin) return null;
  if (input.method !== 'GET' && input.method !== 'HEAD') return null;
  if (input.fetchDest !== 'document' && input.fetchDest !== 'iframe') return null;
  const params = new URLSearchParams(input.search);
  params.set('public_share', input.token);
  return `${input.previewOrigin}${normalizeProxyPath(input.path)}?${params.toString()}`;
}

function normalizeProxyPath(value: string | undefined): string {
  if (!value || value === '/') return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function publicOrigin(c: any): string {
  const url = new URL(c.req.url);
  const host = c.req.header('host') || url.host;
  const proto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

publicShareApp.get('/:token', async (c) => {
  const token = c.req.param('token');
  const resolved = await resolvePublicShare(token);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);
  const row = resolved.row;
  const proxyPath = resourceProxyPath(token, row);
  // A shared preview goes to its OWN origin when this deployment has a preview
  // domain. A shared app is a real site to whoever opens the link: under the
  // path form its root-absolute links (`<a href="/learn">`, `fetch('/api')`,
  // `url(/bg.png)`) resolve against the API origin and 404, which is the whole
  // reason preview origins exist. The `?public_share` token authenticates the
  // first request, and the proxy exchanges it for a cookie (see
  // preview-origin.ts). Without a preview domain — a self-host that never
  // configured one — this stays the token-gated path the routes below handle.
  const previewOrigin = row.externalId
    ? row.resourceType === 'preview' && row.port
      ? previewOriginFor(row.externalId, row.port)
      : row.resourceType === 'file'
        ? previewOriginFor(row.externalId, STATIC_FILE_SHARE_PORT)
        : null
    : null;
  // A transcript share is rendered by the web app, not by the sandbox.
  const publicUrl = row.resourceType === 'transcript'
    ? transcriptShareViewerUrl(token)
    : previewOrigin
    ? row.resourceType === 'file'
      // A shared file is author-controlled content — HTML and SVG carry script.
      // On the path form it renders on the API origin, i.e. with the same
      // principal as /v1/p/…; its own origin is where it belongs.
      ? `${previewOrigin}/open?public_share=${encodeURIComponent(token)}`
      : `${previewOrigin}${normalizeProxyPath(row.path)}?public_share=${encodeURIComponent(token)}`
    : row.resourceType === 'preview'
      ? `${publicOrigin(c)}${proxyPath}`
      : null;
  return c.json({
    share: {
      share_id: row.shareId,
      session_id: row.sessionId,
      project_id: row.projectId,
      resource_type: row.resourceType,
      label: row.label,
      port: row.port,
      path: row.path,
      file_path: row.filePath,
      mode: row.mode,
      allow_websocket: row.allowWebsocket,
      sandbox_status: row.sandboxStatus,
      expires_at: row.expiresAt?.toISOString() ?? null,
      proxy_path: proxyPath,
      public_url: publicUrl,
    },
  });
});

async function forwardPublicShare(c: any, args: {
  share: any;
  port: number;
  remainingPath: string;
  queryString: string;
  redirectPrefix: string;
}) {
  const method = c.req.method.toUpperCase();
  if (args.share.resourceType === 'file' && !PUBLIC_SHARE_VIEW_METHODS.has(method)) {
    return c.json({ error: 'This public share is view-only' }, 405);
  }
  // A view-mode PREVIEW share must also be view-only: without this gate a holder
  // of a `mode:'view'` preview link could POST/PUT/DELETE to the sandboxed
  // preview app. Mirrors the file branch above. See SSR-PV1 (weekly pentest #4).
  if (
    args.share.resourceType === 'preview' &&
    args.share.mode === 'view' &&
    !PUBLIC_SHARE_VIEW_METHODS.has(method)
  ) {
    return c.json({ error: 'This public share is view-only' }, 405);
  }

  const origin = c.req.header('Origin') || '';
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await c.req.raw.clone().arrayBuffer();
  }

  // Ownership, service-key auth, auto-wake retries and redirect rewriting live
  // in the one shared forwarder; this edge keeps only its own response policy.
  const upstream = await forwardToSandbox(
    args.share.externalId!,
    args.port,
    { kind: 'public_share' },
    method,
    args.remainingPath,
    args.queryString,
    c.req.raw.headers,
    body,
    origin,
    args.redirectPrefix,
    publicOrigin(c),
  );
  void touchPublicShare(args.share.shareId).catch(() => {});
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: publicResponseHeaders(upstream.headers, origin),
  });
}

function fileOpenQuery(filePath: string): string {
  return `?path=${encodeURIComponent(filePath)}`;
}

function assertFileShare(share: any) {
  if (share.resourceType !== 'file' || !share.filePath) {
    return { ok: false as const };
  }
  return { ok: true as const, filePath: share.filePath as string };
}

async function forwardFileShare(c: any, args: {
  token: string;
  share: any;
  remainingPath: string;
  queryString: string;
}) {
  const file = assertFileShare(args.share);
  if (!file.ok) return c.json({ error: 'Not authorized for this file' }, 403);

  const isFileEntry = args.remainingPath === '/' || args.remainingPath === '/open';
  if (!isFileEntry) {
    return c.json({ error: 'Not authorized for this file path' }, 403);
  }
  const redirect = previewNavigationRedirect({
    method: c.req.method.toUpperCase(),
    fetchDest: c.req.header('sec-fetch-dest'),
    previewOrigin: args.share.externalId
      ? previewOriginFor(args.share.externalId, STATIC_FILE_SHARE_PORT)
      : null,
    path: '/open',
    search: '',
    token: args.token,
  });
  if (redirect) return c.redirect(redirect, 302);
  return forwardPublicShare(c, {
    share: args.share,
    port: STATIC_FILE_SHARE_PORT,
    remainingPath: '/open',
    queryString: fileOpenQuery(file.filePath),
    redirectPrefix: `/v1/p/public-share/${args.token}/file`,
  });
}

publicShareApp.all('/:token/file', async (c) => {
  const token = c.req.param('token');
  const resolved = await resolvePublicShare(token);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);
  return forwardFileShare(c, {
    token,
    share: resolved.row,
    remainingPath: '/',
    queryString: new URL(c.req.url).search,
  });
});

publicShareApp.all('/:token/file/*', async (c) => {
  const token = c.req.param('token');
  const resolved = await resolvePublicShare(token);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);
  const fullPath = new URL(c.req.url).pathname;
  const prefix = `/public-share/${token}/file`;
  const prefixIndex = fullPath.indexOf(prefix);
  const remainingPath = normalizeProxyPath(
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefix.length) : '/',
  );
  return forwardFileShare(c, {
    token,
    share: resolved.row,
    remainingPath,
    queryString: new URL(c.req.url).search,
  });
});

publicShareApp.all('/:token/:port/*', async (c) => {
  const token = c.req.param('token');
  const port = Number(c.req.param('port'));
  const resolved = await resolvePublicShare(token);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);

  const share = resolved.row;
  if (
    share.resourceType !== 'preview'
    || !Number.isInteger(port)
    || port !== share.port
    || PUBLIC_SHARE_BLOCKED_PORTS.has(port)
  ) {
    return c.json({ error: 'Not authorized for this port' }, 403);
  }

  const fullPath = new URL(c.req.url).pathname;
  const prefix = `/public-share/${token}/${port}`;
  const prefixIndex = fullPath.indexOf(prefix);
  const remainingPath = normalizeProxyPath(
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefix.length) : '/',
  );
  const upstreamUrl = new URL(c.req.url);
  const redirect = previewNavigationRedirect({
    method: c.req.method.toUpperCase(),
    fetchDest: c.req.header('sec-fetch-dest'),
    previewOrigin: share.externalId ? previewOriginFor(share.externalId, port) : null,
    path: remainingPath,
    search: upstreamUrl.search,
    token,
  });
  if (redirect) return c.redirect(redirect, 302);
  return forwardPublicShare(c, {
    share,
    port,
    remainingPath,
    queryString: upstreamUrl.search,
    redirectPrefix: `/v1/p/public-share/${token}/${port}`,
  });
});

publicShareApp.all('/:token/:port', async (c) => {
  const token = c.req.param('token');
  const port = c.req.param('port');
  const url = new URL(c.req.url);
  return c.redirect(`/v1/p/public-share/${token}/${port}/${url.search}`, 301);
});

export { publicShareApp };
