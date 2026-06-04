import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getTraceHeaders } from '../../lib/request-context';
import { listProjectSecretsSnapshotForUser } from '../../projects/secrets';
import { resolveShareSubject } from '../../executor/share';
import { canAccessPreviewSandbox } from '../../shared/preview-ownership';
import {
  buildSandboxUpstreamHeaders,
  invalidatePreviewLink,
  loadSandbox,
  markSandboxErrored,
  markSandboxUsed,
  resolvePreviewLink,
  wakeSandbox,
} from '../backend';

// `userId` is set by combinedAuth (mounted in ../index.ts) before this route.
const preview = new Hono<{ Variables: { userId: string; userEmail: string } }>();

// Hop-by-hop + caller-controlled headers we never forward upstream. Auth is
// replaced with the sandbox service key, trace headers are regenerated, and
// Accept-Encoding is forced to identity (raw byte passthrough).
const STRIP_FORWARD_HEADERS = new Set([
  'host',
  'authorization',
  'traceparent',
  'x-request-id',
  'accept-encoding',
]);

function jsonProxyError(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Rewrite an upstream redirect Location so the user stays on the preview.
// `redirectPrefix` is the URL prefix that maps to this sandbox port:
//   - subdomain previews (p{port}-{sandbox}.host):  '' (root-relative)
//   - path-based previews (/v1/p/{sandbox}/{port}):  '/v1/p/{sandbox}/{port}'
// App self-redirects (relative, or absolute to the upstream's own origin) are
// kept on the preview. Genuinely external redirects (OAuth, CDNs, …) pass
// through unchanged so the browser can follow them — we never hard-block, since
// blocking turned ordinary app redirects into 502s.
function sanitizeRedirectLocation(
  previewUrl: string,
  location: string | null,
  redirectPrefix: string,
): string | null {
  if (!location) return null;
  if (location.startsWith('/') && !location.startsWith('//')) {
    return `${redirectPrefix}${location}`;
  }
  try {
    const target = new URL(location, previewUrl);
    const preview = new URL(previewUrl);
    const selfHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(target.hostname);
    if (target.origin === preview.origin || selfHost) {
      return `${redirectPrefix}${target.pathname}${target.search}${target.hash}`;
    }
    return location;
  } catch {
    return null;
  }
}

// === Project-env pre-sync (before a prompt reaches opencode) ===

function shouldSyncProjectEnvBeforeProxy(port: number, method: string, path: string): boolean {
  if (port !== 8000) return false;
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/session\/[^/]+\/(?:prompt_async|message)(?:$|[/?#])/.test(path);
}

async function syncProjectEnvToSandbox(input: {
  projectId: string;
  userId: string;
  previewUrl: string;
  previewToken: string | null;
  serviceKey: string | null;
}): Promise<void> {
  if (!input.serviceKey) return;

  // Resolve as the acting user so the re-sync keeps personal overrides and
  // share-scope restrictions consistent with what was injected at boot.
  const subject = await resolveShareSubject(input.userId);
  const snapshot = await listProjectSecretsSnapshotForUser(input.projectId, subject);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${input.serviceKey}`,
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (input.previewToken) headers['X-Daytona-Preview-Token'] = input.previewToken;

  const res = await fetch(`${input.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`project env sync failed: ${res.status}${body ? ` ${body.slice(0, 500)}` : ''}`);
  }
}

// === Core HTTP forwarder ======================================================
//
// Forwards one request to a sandbox port with ownership enforcement, the full
// upstream auth header set, auto-wake retries, redirect rewriting, and CORS
// injection. Exported so both proxy edges use it: the path-based Hono route
// below and the subdomain handler (src/sandbox-proxy/subdomain.ts).

export async function forwardToSandbox(
  sandboxId: string,
  port: number,
  userId: string,
  method: string,
  remainingPath: string,
  queryString: string,
  incomingHeaders: Headers,
  body: ArrayBuffer | undefined,
  origin: string,
  // URL prefix that maps to this sandbox port, used to rewrite redirects.
  // Defaults to the path-based form; subdomain callers pass '' (root-relative).
  redirectPrefix: string = `/v1/p/${sandboxId}/${port}`,
  // Public origin (scheme://host) the client used to reach this sandbox port.
  // Combined with `redirectPrefix` to form X-Forwarded-Prefix — the full public
  // base URL the sandbox needs so the static-web <base> tag and OpenAPI server
  // URL resolve to browser-reachable addresses. Callers pass this explicitly so
  // the scheme is correct in every environment (http in local dev, https behind
  // a TLS-terminating LB). Falls back to reconstructing from the Host header.
  publicOrigin?: string,
): Promise<Response> {
  // 1. One row fetch — enforces the v1 session-sandbox contract, ownership, and
  // active state, and yields the service key for upstream auth. (Previously two
  // separate queries for the same row.)
  const record = await loadSandbox(sandboxId);
  if (!record) {
    return jsonProxyError({ error: 'sandbox not found' }, 404);
  }
  if (!(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))) {
    throw new HTTPException(403, {
      message: `Not authorized to access this sandbox, userId: ${userId}, sandboxId: ${sandboxId}`,
    });
  }
  if (record.status !== 'active') {
    return jsonProxyError({ error: 'sandbox not ready', status: record.status }, 503);
  }
  const serviceKey = record.serviceKey;

  // 2. Forward with auto-wake retry.
  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [2000, 5000, 8000]; // progressive delays to let sandbox boot
  let wakeTriggered = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { url: previewUrl, token: previewToken } = await resolvePreviewLink(record, port);
      const targetUrl = previewUrl.replace(/\/$/, '') + remainingPath + queryString;

      if (shouldSyncProjectEnvBeforeProxy(port, method, remainingPath)) {
        try {
          await syncProjectEnvToSandbox({
            projectId: record.projectId,
            userId,
            previewUrl,
            previewToken,
            serviceKey,
          });
        } catch (err) {
          throw new HTTPException(502, {
            message: (err as Error).message || 'project env sync failed',
          });
        }
      }

      // Build forwarding headers: copy the client's (minus stripped), force
      // identity encoding, regenerate trace headers, then apply the sandbox
      // auth/identity headers (service key, preview token, signed user-context)
      // last so they always win.
      const headers = new Headers();
      for (const [key, value] of incomingHeaders.entries()) {
        if (STRIP_FORWARD_HEADERS.has(key.toLowerCase())) continue;
        headers.set(key, value);
      }
      headers.set('Accept-Encoding', 'identity');
      for (const [key, value] of Object.entries(getTraceHeaders())) {
        headers.set(key, value);
      }
      const authHeaders = await buildSandboxUpstreamHeaders({
        sandboxId,
        userId,
        serviceKey,
        previewToken,
      });
      for (const [key, value] of Object.entries(authHeaders)) {
        headers.set(key, value);
      }

      // Public base URL the client used, so the sandbox emits browser-reachable
      // URLs (static-web <base> tag, OpenAPI server URL). origin + redirectPrefix
      // is exactly the prefix the client sees.
      const resolvedOrigin =
        publicOrigin ??
        (() => {
          const originalHost = incomingHeaders.get('host');
          if (!originalHost) return null;
          const proto = incomingHeaders.get('x-forwarded-proto') || 'https';
          return `${proto}://${originalHost}`;
        })();
      if (resolvedOrigin) {
        headers.set('X-Forwarded-Prefix', `${resolvedOrigin}${redirectPrefix}`);
      }

      console.log(
        `[PREVIEW] ${method} ${sandboxId}:${port}${remainingPath} -> ${targetUrl}${attempt > 0 ? ` (retry ${attempt})` : ''}`,
      );

      const upstream = await fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        // @ts-ignore — Bun extensions: no decompression (raw byte passthrough), duplex streaming
        decompress: false,
        duplex: 'half',
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        const respHeaders = new Headers(upstream.headers);
        const safeLocation = sanitizeRedirectLocation(
          previewUrl,
          upstream.headers.get('location'),
          redirectPrefix,
        );
        if (safeLocation) respHeaders.set('Location', safeLocation);
        if (origin) {
          respHeaders.set('Access-Control-Allow-Origin', origin);
          respHeaders.set('Access-Control-Allow-Credentials', 'true');
        }
        return new Response(null, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: respHeaders,
        });
      }

      if (upstream.status === 401 && serviceKey && userId) {
        console.warn(`[PREVIEW] Sandbox ${sandboxId}:${port} rejected signed user context`);
        return jsonProxyError({ error: 'sandbox proxy authentication rejected' }, 502);
      }

      // Daytona returns various error codes when the sandbox isn't ready:
      //   400 "no IP address found" — sandbox is stopped
      //   400 "failed to get runner info" — sandbox is archived (no runner)
      //   502 — container started but the port isn't listening yet
      //   503 — sandbox service temporarily unavailable
      // Retry with auto-wake so users don't see errors during the boot window.
      if (upstream.status === 503) {
        const bodyText = await upstream.clone().text().catch(() => '');
        if (bodyText.includes('opencode not ready')) {
          void markSandboxUsed(sandboxId);
          const notReadyHeaders = new Headers(upstream.headers);
          if (origin) {
            notReadyHeaders.set('Access-Control-Allow-Origin', origin);
            notReadyHeaders.set('Access-Control-Allow-Credentials', 'true');
          }
          return new Response(bodyText, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: notReadyHeaders,
          });
        }
      }

      if ((upstream.status === 502 || upstream.status === 503) && attempt < MAX_RETRIES) {
        // Port not ready yet — sandbox is booting (container running, port down).
        console.warn(
          `[PREVIEW] Sandbox ${sandboxId}:${port} returned ${upstream.status} (port not ready, attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
        );
        invalidatePreviewLink(sandboxId, port);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }

      if (upstream.status === 400 && attempt < MAX_RETRIES) {
        const bodyText = await upstream.text();
        const isSandboxDown =
          bodyText.includes('no IP address found') ||
          bodyText.includes('failed to get runner info');
        if (isSandboxDown) {
          if (!wakeTriggered) {
            console.warn(
              `[PREVIEW] Sandbox ${sandboxId} is stopped/archived (Daytona: ${bodyText.slice(0, 120)}), triggering wake`,
            );
            await wakeSandbox(sandboxId);
            wakeTriggered = true;
          } else {
            console.warn(
              `[PREVIEW] Sandbox ${sandboxId} still booting (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
            );
          }
          invalidatePreviewLink(sandboxId, port);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        // Not a Daytona stopped error — pass through.
        const errHeaders = new Headers(upstream.headers);
        if (origin) {
          errHeaders.set('Access-Control-Allow-Origin', origin);
          errHeaders.set('Access-Control-Allow-Credentials', 'true');
        }
        return new Response(bodyText, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: errHeaders,
        });
      }

      // Got an HTTP response → sandbox is alive, pass it through with CORS.
      void markSandboxUsed(sandboxId);
      const respHeaders = new Headers(upstream.headers);
      if (origin) {
        respHeaders.set('Access-Control-Allow-Origin', origin);
        respHeaders.set('Access-Control-Allow-Credentials', 'true');
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      // Re-throw our own HTTP exceptions (400, 403, etc.) — don't retry those.
      if (err instanceof HTTPException) throw err;

      console.warn(
        `[PREVIEW] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${sandboxId}:${port}: ${(err as Error).message || err}`,
      );

      if (!wakeTriggered) {
        await wakeSandbox(sandboxId);
        wakeTriggered = true;
      }
      if (attempt < MAX_RETRIES) {
        invalidatePreviewLink(sandboxId, port);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // All retries exhausted — error the row so we stop hammering a dead instance.
  await markSandboxErrored(sandboxId);
  throw new HTTPException(502, {
    message: 'Sandbox upstream unreachable. Please retry in a few seconds.',
  });
}

// === WebSocket upstream resolution =============================================
//
// Resolves the upstream WS URL + auth headers for a preview WebSocket. The
// actual upgrade + byte-piping happens at the Bun.serve level (ws-proxy.ts);
// this reuses the exact same ownership gate, service key, and signed
// user-context as the HTTP forwarder so the security posture is identical.

export async function resolvePreviewWsUpstream(opts: {
  sandboxId: string;
  upstreamPort: number;
  userId: string;
  remainingPath: string;
  queryString: string;
}): Promise<
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; status: number; message: string }
> {
  const { sandboxId, upstreamPort, userId, remainingPath, queryString } = opts;

  const record = await loadSandbox(sandboxId);
  if (!record) return { ok: false, status: 404, message: 'sandbox not found' };
  if (!(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))) {
    return { ok: false, status: 403, message: 'not authorized' };
  }
  if (record.status !== 'active') {
    return { ok: false, status: 503, message: 'sandbox not ready' };
  }

  const { url: previewUrl, token: previewToken } = await resolvePreviewLink(record, upstreamPort);
  const wsBase = previewUrl
    .replace(/\/$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:');
  const url = wsBase + remainingPath + queryString;

  const headers = await buildSandboxUpstreamHeaders({
    sandboxId,
    userId,
    serviceKey: record.serviceKey,
    previewToken,
  });

  return { ok: true, url, headers };
}

// === Route handlers: ALL /:sandboxId/:port(/*) ===
//
// Thin wrappers around forwardToSandbox — extract params from the Hono context.

preview.all('/:sandboxId/:port/*', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const portStr = c.req.param('port');
  const port = parseInt(portStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new HTTPException(400, { message: `Invalid port: ${portStr}` });
  }

  const userId = c.get('userId') as string;

  const method = c.req.method;
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await c.req.raw.clone().arrayBuffer();
  }

  const fullPath = new URL(c.req.url).pathname;
  const prefixPattern = `/${sandboxId}/${portStr}`;
  const prefixIndex = fullPath.indexOf(prefixPattern);
  const remainingPath =
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefixPattern.length) || '/' : '/';
  const upstreamUrl = new URL(c.req.url);
  upstreamUrl.searchParams.delete('token');
  const queryString = upstreamUrl.search;

  const origin = c.req.header('Origin') || '';

  // Public origin the client used. Prefer X-Forwarded-Proto (TLS-terminating LB
  // in prod), else the scheme the request actually arrived on — never assume
  // https, which breaks the static-web <base> tag over http in local dev.
  const proto = c.req.header('x-forwarded-proto') || upstreamUrl.protocol.replace(':', '');
  const host = c.req.header('host') || upstreamUrl.host;
  const publicOrigin = `${proto}://${host}`;

  return forwardToSandbox(
    sandboxId, port, userId, method, remainingPath, queryString,
    c.req.raw.headers, body, origin,
    undefined, // redirectPrefix → default `/v1/p/{sandbox}/{port}`
    publicOrigin,
  );
});

// Requests without a trailing path (e.g. /:sandboxId/:port) → normalize.
preview.all('/:sandboxId/:port', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const port = c.req.param('port');
  const url = new URL(c.req.url);
  return c.redirect(`/${sandboxId}/${port}/${url.search}`, 301);
});

export { preview };
