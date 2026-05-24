import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, inArray, ne } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { getDaytona } from '../../shared/daytona';
import { db } from '../../shared/db';
import { getProvider, type ProviderName } from '../../platform/providers';
import {
  canAccessPreviewSandbox,
  resolvePreviewUserContext,
} from '../../shared/preview-ownership';
import {
  encodeKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER,
} from '../../shared/kortix-user-context';
import { getTraceHeaders } from '../../lib/request-context';

interface PreviewProxyContext {
  userId: string;
  userEmail: string;
}

const preview = new Hono<{ Variables: PreviewProxyContext }>();

// === In-memory caches with TTL ===

interface PreviewLinkEntry {
  url: string;
  token: string | null;
  expiresAt: number;
}

interface ServiceKeyEntry {
  key: string | null;
  expiresAt: number;
}

type SessionSandboxProxyRow = {
  sandboxId: string;
  status: string;
  config: Record<string, unknown> | null;
  provider: ProviderName;
};

type SandboxProxyAccess =
  | { ok: true; serviceKey: string | null; provider: ProviderName }
  | { ok: false; response: Response };

// In-process cache of (externalId → provider) so the per-request lookup in
// resolvePreviewLink/wakeSandbox doesn't double up DB queries on the hot path.
const providerCache = new Map<string, { provider: ProviderName; expiresAt: number }>();
function cacheProvider(externalId: string, provider: ProviderName) {
  providerCache.set(externalId, { provider, expiresAt: Date.now() + CACHE_TTL_MS });
}
function getCachedProvider(externalId: string): ProviderName | null {
  const e = providerCache.get(externalId);
  if (!e || Date.now() > e.expiresAt) { providerCache.delete(externalId); return null; }
  return e.provider;
}
async function resolveProviderForExternalId(externalId: string): Promise<ProviderName> {
  const cached = getCachedProvider(externalId);
  if (cached) return cached;
  const [row] = await db
    .select({ provider: sessionSandboxes.provider })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  const provider = (row?.provider as ProviderName) ?? 'daytona';
  cacheProvider(externalId, provider);
  return provider;
}

const previewLinkCache = new Map<string, PreviewLinkEntry>();
const serviceKeyCache = new Map<string, ServiceKeyEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STRIP_FORWARD_HEADERS = new Set([
  'host',
  'authorization',
  'traceparent',
  'x-request-id',
  'accept-encoding',
]);

function getCachedServiceKey(sandboxId: string): string | null | undefined {
  const entry = serviceKeyCache.get(sandboxId);
  if (!entry || Date.now() > entry.expiresAt) {
    serviceKeyCache.delete(sandboxId);
    return undefined; // cache miss
  }
  return entry.key; // null = no key stored, string = key
}

function setCachedServiceKey(sandboxId: string, key: string | null) {
  serviceKeyCache.set(sandboxId, { key, expiresAt: Date.now() + CACHE_TTL_MS });
}

function jsonProxyError(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractServiceKey(config: Record<string, unknown> | null | undefined): string | null {
  return typeof config?.serviceKey === 'string' ? config.serviceKey : null;
}

async function loadSessionSandboxForProxy(sandboxId: string): Promise<SessionSandboxProxyRow | null> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      status: sessionSandboxes.status,
      config: sessionSandboxes.config,
      provider: sessionSandboxes.provider,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, sandboxId))
    .limit(1);

  if (row) cacheProvider(sandboxId, row.provider as ProviderName);
  return row ? { ...row, provider: row.provider as ProviderName } : null;
}

async function validateSandboxProxyAccess(
  sandboxId: string,
  userId: string,
): Promise<SandboxProxyAccess> {
  const row = await loadSessionSandboxForProxy(sandboxId);
  if (!row) {
    return { ok: false, response: jsonProxyError({ error: 'sandbox not found' }, 404) };
  }

  const allowed = await verifyOwnership(sandboxId, userId);
  if (!allowed) {
    throw new HTTPException(403, {
      message: `Not authorized to access this sandbox, userId: ${userId}, sandboxId: ${sandboxId}`,
    });
  }

  if (row.status !== 'active') {
    return {
      ok: false,
      response: jsonProxyError({ error: 'sandbox not ready', status: row.status }, 503),
    };
  }

  const serviceKey = extractServiceKey(row.config);
  setCachedServiceKey(sandboxId, serviceKey);
  return { ok: true, serviceKey, provider: row.provider };
}

function getCachedPreviewLink(sandboxId: string, port: number): PreviewLinkEntry | null {
  const key = `${sandboxId}:${port}`;
  const entry = previewLinkCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    previewLinkCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedPreviewLink(sandboxId: string, port: number, url: string, token: string | null) {
  const key = `${sandboxId}:${port}`;
  previewLinkCache.set(key, { url, token, expiresAt: Date.now() + CACHE_TTL_MS });
}

// === Ownership verification via kortix.sandboxes ===
//
// Delegates to the shared helper so the Daytona proxy path, the preview
// auth middleware, and the subdomain token validator all agree on a
// single definition of "user X can hit sandbox Y". See the rationale in
// `shared/preview-ownership.ts`: we used to do a global "who owns
// externalId=X" lookup, which broke in local-docker mode where every
// user shares the `kortix-sandbox` container name and a stale row from
// a previous user would lock everyone else out with 403.

async function verifyOwnership(sandboxId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  return canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId });
}

function sanitizeRedirectLocation(
  previewUrl: string,
  location: string | null,
  sandboxId: string,
  port: number,
): string | null {
  if (!location) return null;
  if (location.startsWith('/') && !location.startsWith('//')) return location;

  try {
    const target = new URL(location, previewUrl);
    const preview = new URL(previewUrl);
    if (target.origin !== preview.origin) return null;
    return `/v1/p/${sandboxId}/${port}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

// === Service key resolution (for authenticating proxy → sandbox) ===

async function resolveServiceKey(sandboxId: string): Promise<string | null> {
  const cached = getCachedServiceKey(sandboxId);
  if (cached !== undefined) return cached;

  try {
    const [row] = await db
      .select({ config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.externalId, sandboxId))
      .limit(1);

    const key = (row?.config as Record<string, unknown> | undefined)?.serviceKey as string | null ?? null;
    setCachedServiceKey(sandboxId, key);
    return key;
  } catch {
    return null;
  }
}

// === Preview link resolution (no state checking -- let proxy detect if sandbox is down) ===

async function resolvePreviewLink(
  sandboxId: string,
  port: number
): Promise<{ url: string; token: string | null }> {
  const cached = getCachedPreviewLink(sandboxId, port);
  if (cached) return { url: cached.url, token: cached.token };

  const provider = await resolveProviderForExternalId(sandboxId);
  if (provider === 'platinum') {
    // Platinum's resolveEndpoint() re-calls /v1/sandboxes/:id/expose so the
    // HMAC URL stays fresh across stop/start (host may move). Hardcoded to
    // port 8000 in the provider today; for other ports we'd need to extend
    // the SandboxProvider interface.
    const ep = await getProvider('platinum').resolveEndpoint(sandboxId);
    setCachedPreviewLink(sandboxId, port, ep.url, null);
    return { url: ep.url, token: null };
  }

  // Daytona path — the original SDK call.
  const daytona = getDaytona();
  const sandbox = await daytona.get(sandboxId);
  const link = await (sandbox as any).getPreviewLink(port);
  const url = link.url || String(link);
  const token = link.token || null;
  setCachedPreviewLink(sandboxId, port, url, token);
  return { url, token };
}

// === Wake sandbox (called only when proxy fails with connection error) ===

async function wakeSandbox(sandboxId: string): Promise<void> {
  try {
    const provider = await resolveProviderForExternalId(sandboxId);
    if (provider === 'platinum') {
      await getProvider('platinum').ensureRunning(sandboxId);
      console.log(`[PREVIEW] Wake-up triggered for Platinum sandbox ${sandboxId}`);
      return;
    }
    const daytona = getDaytona();
    const sandbox = await daytona.get(sandboxId);
    await (sandbox as any).start?.();
    console.log(`[PREVIEW] Wake-up triggered for sandbox ${sandboxId}`);
  } catch (e) {
    console.error(`[PREVIEW] Failed to wake sandbox ${sandboxId}:`, e);
  }
}

async function markSandboxUsed(sandboxId: string): Promise<void> {
  if (typeof db.update !== 'function') return;
  const now = new Date();
  try {
    await db
      .update(sessionSandboxes)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(and(eq(sessionSandboxes.externalId, sandboxId), ne(sessionSandboxes.status, 'archived')));

    await db
      .update(sessionSandboxes)
      .set({ status: 'active', lastUsedAt: now, updatedAt: now })
      .where(and(
        eq(sessionSandboxes.externalId, sandboxId),
        inArray(sessionSandboxes.status, ['error', 'stopped']),
      ));
  } catch (err) {
    console.warn('[PREVIEW] Failed to mark sandbox used:', err);
  }
}

// === Core Daytona proxy function ================================================
//
// Exported so index.ts can call it directly in dual-provider mode.
// Handles ownership verification, Daytona preview link resolution,
// auto-wake retry, CORS injection — the full Daytona proxy pipeline.
//
// Parameters mirror what the route handler extracts from the Hono context.

export async function proxyToDaytona(
  sandboxId: string,
  port: number,
  userId: string,
  method: string,
  remainingPath: string,
  queryString: string,
  incomingHeaders: Headers,
  body: ArrayBuffer | undefined,
  origin: string,
): Promise<Response> {
  // 1. Enforce the v1 session-sandbox contract before touching Daytona or
  // local Docker: only active rows in `kortix.session_sandboxes` are proxyable.
  const access = await validateSandboxProxyAccess(sandboxId, userId);
  if (!access.ok) return access.response;
  const serviceKey = access.serviceKey ?? await resolveServiceKey(sandboxId);

  // 2. Proxy with auto-wake retry
  const MAX_RETRIES = 5;
  // Tight ramp catches the kortix-master restart window (post-warm-claim
  // dnah-apply-env bounces the s6 service to pick up the per-session
  // KORTIX_TOKEN; bun + opencode rebind port 8000 in ~2-4s). Previous
  // [2s, 5s, 8s] meant a request landing mid-restart waited a full 11-15s
  // for the 4th attempt to land. New curve: max 200+500+1000+2000+3000 = 6.7s
  // worst case, ~1s typical when restart is in flight, and 2 extra fast
  // attempts means we don't burn the whole window on early misses.
  const RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000];
  let wakeTriggered = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Resolve preview link (cached on happy path = zero overhead)
      const { url: previewUrl, token: previewToken } = await resolvePreviewLink(sandboxId, port);
      // Daytona URLs are bare (`https://port-id.proxy.daytona.work`) — naive
      // concat works. Platinum URLs carry the HMAC in `?t=<token>`; naive
      // concat puts the path AFTER the token, mangling the HMAC. Parse and
      // rebuild: replace pathname, merge query strings.
      const parsedPreview = new URL(previewUrl);
      parsedPreview.pathname = remainingPath || '/';
      if (queryString) {
        const incomingParams = new URLSearchParams(queryString.replace(/^\?/, ''));
        for (const [k, v] of incomingParams) parsedPreview.searchParams.append(k, v);
      }
      const targetUrl = parsedPreview.toString();

      // Build forwarding headers — strip user's JWT, inject sandbox service key
      const headers = new Headers();
      for (const [key, value] of incomingHeaders.entries()) {
        const lower = key.toLowerCase();
        if (STRIP_FORWARD_HEADERS.has(lower)) continue;
        headers.set(key, value);
      }
      headers.set('Accept-Encoding', 'identity');
      for (const [key, value] of Object.entries(getTraceHeaders())) {
        headers.set(key, value);
      }
      headers.set('X-Daytona-Skip-Preview-Warning', 'true');
      headers.set('X-Daytona-Disable-CORS', 'true');
      if (previewToken) {
        headers.set('X-Daytona-Preview-Token', previewToken);
      }
      // Authenticate to the sandbox using the stored service key (= KORTIX_TOKEN).
      // This replaces the user's Supabase JWT with the sandbox's INTERNAL_SERVICE_KEY.
      if (serviceKey) {
        headers.set('Authorization', `Bearer ${serviceKey}`);
      }

      // Forward a signed identity context so kortix-master can enforce
      // per-user authorization (project ACL + session scoping) without
      // calling back to the API on every request. Only attached when we
      // have both a real user and a shared secret — anonymous/service-only
      // requests (share URLs, webhooks) proxy through unchanged.
      if (userId && serviceKey) {
        const payload = await resolvePreviewUserContext(sandboxId, userId);
        if (payload) {
          const signed = encodeKortixUserContext(payload, serviceKey);
          headers.set(KORTIX_USER_CONTEXT_HEADER, signed);
          console.log(
            `[PREVIEW] signing X-Kortix-User-Context user=${userId} sandbox=${sandboxId} role=${payload.sandboxRole} tokenPrefix=${signed.slice(0, 16)}`,
          );
        } else {
          console.log(
            `[PREVIEW] no signed context resolved user=${userId} sandbox=${sandboxId} (denied or anonymous)`,
          );
        }
      } else {
        console.log(
          `[PREVIEW] skipping signed context userId=${userId ?? 'none'} hasServiceKey=${!!serviceKey}`,
        );
      }

      // Tell the sandbox what the public proxy base URL is so it can set the
      // OpenAPI server URL correctly.
      const originalHost = incomingHeaders.get('host');
      if (originalHost) {
        const proto = incomingHeaders.get('x-forwarded-proto') || 'https';
        headers.set('X-Forwarded-Prefix', `${proto}://${originalHost}/v1/p/${sandboxId}/${port}`);
      }

      console.log(
        `[PREVIEW] ${method} ${sandboxId}:${port}${remainingPath} -> ${targetUrl}${attempt > 0 ? ` (retry ${attempt})` : ''}`
      );

      // Proxy request
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
          sandboxId,
          port,
        );
        if (!safeLocation) {
          return jsonProxyError({ error: 'blocked unsafe upstream redirect' }, 502);
        }
        respHeaders.set('Location', safeLocation);
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

      // Daytona returns various error codes when sandbox isn't ready:
      //   400 "no IP address found" — sandbox is stopped
      //   400 "failed to get runner info" — sandbox is archived (no runner)
      //   502 — sandbox container started but port isn't listening yet
      //   503 — sandbox service temporarily unavailable
      // Detect all and retry with auto-wake so the user doesn't see errors
      // during the boot window (typically 10-30s after provisioning).
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
        // Port not ready yet — sandbox is booting. Retry without wake
        // (the sandbox container is already running, just port 8000 isn't up).
        console.warn(
          `[PREVIEW] Sandbox ${sandboxId}:${port} returned ${upstream.status} (port not ready, attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        previewLinkCache.delete(`${sandboxId}:${port}`);
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
              `[PREVIEW] Sandbox ${sandboxId} is stopped/archived (Daytona: ${bodyText.slice(0, 120)}), triggering wake`
            );
            await wakeSandbox(sandboxId);
            wakeTriggered = true;
          } else {
            console.warn(
              `[PREVIEW] Sandbox ${sandboxId} still booting (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
            );
          }
          previewLinkCache.delete(`${sandboxId}:${port}`);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        // Not a Daytona stopped error -- pass through
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

      // Got an HTTP response -> sandbox is alive, pass it through
      // Inject CORS headers since the raw upstream response won't have them
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
      // Re-throw our own HTTP exceptions (400, 403, etc.) -- don't retry those
      if (err instanceof HTTPException) throw err;

      // Connection-level failure -> sandbox is likely down
      console.warn(
        `[PREVIEW] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${sandboxId}:${port}: ${(err as Error).message || err}`
      );

      // Trigger wake once on first connection failure
      if (!wakeTriggered) {
        await wakeSandbox(sandboxId);
        wakeTriggered = true;
      }

      if (attempt < MAX_RETRIES) {
        // Clear cached preview link in case it went stale
        previewLinkCache.delete(`${sandboxId}:${port}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // All retries exhausted. Auto-mark the session sandbox row as errored
  // so the proxy stops hammering a dead Daytona instance on every request.
  //
  // Platinum exception: when the in-VM service is briefly unreachable on a
  // Platinum sandbox, that's typically a host-edge proxy issue (CP→host
  // forwarding), NOT a dead sandbox. Marking the row 'error' permanently
  // bricks the session even when the sandbox itself is healthy. The
  // Platinum provider exposes its own /v1/sandboxes/:id state endpoint
  // that's authoritative; trust it over preview-proxy retry exhaustion.
  try {
    const [row] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId, status: sessionSandboxes.status, provider: sessionSandboxes.provider })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.externalId, sandboxId), ne(sessionSandboxes.status, 'archived')))
      .limit(1);
    if (row && row.provider !== 'platinum') {
      await db
        .update(sessionSandboxes)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
      console.warn(`[PREVIEW] Auto-marked session sandbox ${row.sandboxId} (external: ${sandboxId}) as error after all retries failed`);
    } else if (row?.provider === 'platinum') {
      console.warn(`[PREVIEW] Skipping auto-mark-error for Platinum sandbox ${row.sandboxId} — host-edge unreachable, sandbox itself may still be alive`);
    }
  } catch (archiveErr) {
    console.warn('[PREVIEW] Failed to auto-mark sandbox as error:', archiveErr);
  }

  throw new HTTPException(502, {
    message: 'Sandbox upstream unreachable. Please retry in a few seconds.',
  });
}

// === Route handler: ALL /:sandboxId/:port/* ===
//
// Zero-overhead proxy with auto-wake:
// - Happy path (sandbox alive): single fetch, no extra API calls
// - Sandbox down: connection error -> wake sandbox -> retry up to 2 more times
//
// Thin wrapper around proxyToDaytona() — extracts params from Hono context.

preview.all('/:sandboxId/:port/*', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const portStr = c.req.param('port');
  const port = parseInt(portStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new HTTPException(400, { message: `Invalid port: ${portStr}` });
  }

  const userId = c.get('userId') as string;

  // Read body once up front (needed across retries)
  const method = c.req.method;
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await c.req.raw.clone().arrayBuffer();
  }

  // Build path & query
  const fullPath = new URL(c.req.url).pathname;
  const prefixPattern = `/${sandboxId}/${portStr}`;
  const prefixIndex = fullPath.indexOf(prefixPattern);
  const remainingPath = prefixIndex !== -1
    ? fullPath.slice(prefixIndex + prefixPattern.length) || '/'
    : '/';
  const upstreamUrl = new URL(c.req.url);
  upstreamUrl.searchParams.delete('token');
  const queryString = upstreamUrl.search;

  const origin = c.req.header('Origin') || '';

  return proxyToDaytona(
    sandboxId, port, userId, method, remainingPath, queryString,
    c.req.raw.headers, body, origin,
  );
});

// Also handle requests without trailing path (e.g. /:sandboxId/:port)
preview.all('/:sandboxId/:port', async (c) => {
  // Redirect to /:sandboxId/:port/ for consistency
  const sandboxId = c.req.param('sandboxId');
  const port = c.req.param('port');
  const url = new URL(c.req.url);
  return c.redirect(`/${sandboxId}/${port}/${url.search}`, 301);
});

export { preview };
