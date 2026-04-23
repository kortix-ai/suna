import { Hono } from 'hono';
import { eq, and, ne } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { config } from '../config';
import { combinedAuth } from '../middleware/auth';
import { preview, proxyToDaytona } from './routes/preview';
import { proxyToSandbox } from './routes/local-preview';
import { getAuthToken } from './routes/auth';
import { shareApp } from './routes/share';
import { db } from '../shared/db';
import { isProxyTokenStale, refreshSandboxProxyToken } from '../platform/providers/justavps';
import { resolvePreviewUserContext } from '../shared/preview-ownership';
import {
  encodeKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER,
} from '../shared/kortix-user-context';

async function buildSignedUserContextHeader(
  sandboxId: string,
  userId: string | undefined,
  serviceKey: string | undefined,
): Promise<Record<string, string>> {
  if (!userId || !serviceKey) {
    console.log(
      `[PREVIEW] skip sign userId=${userId ?? 'none'} hasServiceKey=${!!serviceKey} sandbox=${sandboxId}`,
    );
    return {};
  }
  const payload = await resolvePreviewUserContext(sandboxId, userId);
  if (!payload) {
    console.log(
      `[PREVIEW] no signed context resolved user=${userId} sandbox=${sandboxId} (denied or anonymous)`,
    );
    return {};
  }
  const signed = encodeKortixUserContext(payload, serviceKey);
  console.log(
    `[PREVIEW] signing X-Kortix-User-Context user=${userId} sandbox=${sandboxId} role=${payload.sandboxRole} tokenPrefix=${signed.slice(0, 16)}`,
  );
  return { [KORTIX_USER_CONTEXT_HEADER]: signed };
}

const sandboxProxyApp = new Hono();

// ── Cookie auth endpoint ────────────────────────────────────────────────────
// POST /v1/p/auth — validates JWT and sets __preview_session cookie.
sandboxProxyApp.route('/auth', getAuthToken);

// ── Public URL share endpoint ───────────────────────────────────────────────
// POST /v1/p/share — returns a shareable URL for a sandbox port.
sandboxProxyApp.route('/share', shareApp);

// ── Path-based proxy ────────────────────────────────────────────────────────
// Auth middleware for both modes (Supabase JWT, kortix_ tokens, cookies).
sandboxProxyApp.use('/:sandboxId/:port/*', combinedAuth);
sandboxProxyApp.use('/:sandboxId/:port', combinedAuth);

// ── Provider cache ──────────────────────────────────────────────────────────
// Cache sandbox provider lookups to avoid a DB query on every request.
// Key: externalId, Value: { provider, expiresAt }
type CachedProviderName = 'daytona' | 'local_docker' | 'justavps';
interface ProviderCacheEntry {
  provider: CachedProviderName;
  baseUrl: string;
  serviceKey: string;
  proxyToken: string;
  slug: string;
  expiresAt: number;
}
const providerCache = new Map<string, ProviderCacheEntry>();
const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ParsedProxyRequest {
  method: string;
  remainingPath: string;
  queryString: string;
  body?: ArrayBuffer;
  origin: string;
  headers: Headers;
}

function isLocalBridgeSandboxId(sandboxId: string): boolean {
  return sandboxId === config.SANDBOX_CONTAINER_NAME;
}

async function parseProxyRequest(c: { req: { url: string; method: string; raw: Request; header: (name: string) => string | undefined } }, sandboxId: string, port: number): Promise<ParsedProxyRequest> {
  const fullPath = new URL(c.req.url).pathname;
  const prefix = `/${sandboxId}/${port}`;
  const idx = fullPath.indexOf(prefix);
  const remainingPath = idx !== -1 ? fullPath.slice(idx + prefix.length) || '/' : '/';
  const queryString = new URL(c.req.url).search;
  const method = c.req.method;

  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await c.req.raw.arrayBuffer();
  }

  return {
    method,
    remainingPath,
    queryString,
    body,
    origin: c.req.header('Origin') || '',
    headers: c.req.raw.headers,
  };
}

/**
 * Drop a sandbox from the in-process provider cache so the next request
 * re-reads from the DB. Used after a proxy-token refresh so cached stale
 * tokens aren't served for up to PROVIDER_CACHE_TTL_MS.
 */
export function invalidateProviderCache(externalId: string): void {
  providerCache.delete(externalId);
}

export async function resolveProvider(externalId: string): Promise<{ provider: CachedProviderName; baseUrl: string; serviceKey: string; proxyToken: string; slug: string } | null> {
  const cached = providerCache.get(externalId);
  if (cached && Date.now() < cached.expiresAt) {
    return { provider: cached.provider, baseUrl: cached.baseUrl, serviceKey: cached.serviceKey, proxyToken: cached.proxyToken, slug: cached.slug };
  }
  providerCache.delete(externalId);

  try {
    const [sandbox] = await db
      .select({ provider: sandboxes.provider, baseUrl: sandboxes.baseUrl, config: sandboxes.config, metadata: sandboxes.metadata })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.externalId, externalId),
          ne(sandboxes.status, 'pooled'),
        )
      )
      .limit(1);

    if (!sandbox) {
      if (isLocalBridgeSandboxId(externalId)) {
        const fallbackServiceKey = config.INTERNAL_SERVICE_KEY;
        providerCache.set(externalId, {
          provider: 'local_docker',
          baseUrl: '',
          serviceKey: fallbackServiceKey,
          proxyToken: '',
          slug: '',
          expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
        });
        return {
          provider: 'local_docker',
          baseUrl: '',
          serviceKey: fallbackServiceKey,
          proxyToken: '',
          slug: '',
        };
      }
      return null;
    }

    const provider = sandbox.provider as CachedProviderName;
    const baseUrl = sandbox.baseUrl || '';
    const configJson = (sandbox.config || {}) as Record<string, unknown>;
    const serviceKey = typeof configJson.serviceKey === 'string' ? configJson.serviceKey : '';
    const metaJson = (sandbox.metadata || {}) as Record<string, unknown>;
    let proxyToken = typeof metaJson.justavpsProxyToken === 'string' ? metaJson.justavpsProxyToken : '';
    const slug = typeof metaJson.justavpsSlug === 'string' ? metaJson.justavpsSlug : '';

    // Refresh the JustAVPS proxy token if it's missing, legacy, or within the
    // refresh buffer of expiry. Shared helper in providers/justavps.ts handles
    // minting, persistence, old-token revocation, and in-process dedup.
    if (provider === 'justavps' && config.JUSTAVPS_API_KEY && isProxyTokenStale(metaJson)) {
      const refreshed = await refreshSandboxProxyToken(externalId, metaJson);
      if (refreshed) {
        proxyToken = refreshed.token;
        console.log(`[PREVIEW] Refreshed proxy token for JustAVPS sandbox ${externalId}`);
      }
    }

    // Don't cache JustAVPS entries without a proxy token — retry on next request
    const cacheTtl = (provider === 'justavps' && !proxyToken) ? 0 : PROVIDER_CACHE_TTL_MS;
    providerCache.set(externalId, { provider, baseUrl, serviceKey, proxyToken, slug, expiresAt: Date.now() + cacheTtl });
    return { provider, baseUrl, serviceKey, proxyToken, slug };
  } catch (err) {
    console.error(`[PREVIEW] Provider lookup failed for ${externalId}:`, err);
    return null;
  }
}

// ── Single-provider fast paths ──────────────────────────────────────────────
// When only ONE provider is configured, skip the per-request DB lookup entirely
// and route all requests to the appropriate handler (same behavior as before).

const enabledCount = [config.isDaytonaEnabled(), config.isLocalDockerEnabled(), config.isJustAVPSEnabled()].filter(Boolean).length;

if (enabledCount === 1 && config.isDaytonaEnabled()) {
  // Cloud-only: all requests go to Daytona preview handler
  sandboxProxyApp.route('/', preview);
} else if (enabledCount === 1 && config.isLocalDockerEnabled()) {
  // Local-only: all requests go to local Docker proxy
  const localOnlyProxy = new Hono();

  localOnlyProxy.all('/:sandboxId/:port/*', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const port = parseInt(c.req.param('port'), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return c.json({ error: `Invalid port: ${c.req.param('port')}` }, 400);
    }
    const request = await parseProxyRequest(c, sandboxId, port);

    const resolved = await resolveProvider(sandboxId);
    if (!resolved || resolved.provider !== 'local_docker') {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    return proxyToSandbox(sandboxId, port, request.method, request.remainingPath, request.queryString, request.headers, request.body, false, request.origin, undefined, resolved.serviceKey);
  });

  localOnlyProxy.all('/:sandboxId/:port', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const port = c.req.param('port');
    return c.redirect(`/${sandboxId}/${port}/`, 301);
  });

  sandboxProxyApp.route('/', localOnlyProxy);
} else if (enabledCount === 1 && config.isJustAVPSEnabled()) {
  // JustAVPS-only: route through CF Worker proxy at {port}--{slug}.kortix.cloud
  const justavpsOnlyProxy = new Hono<{ Variables: { userId: string; userEmail: string } }>();

  justavpsOnlyProxy.all('/:sandboxId/:port/*', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const port = parseInt(c.req.param('port'), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return c.json({ error: `Invalid port: ${c.req.param('port')}` }, 400);
    }
    const request = await parseProxyRequest(c, sandboxId, port);

    if (isLocalBridgeSandboxId(sandboxId)) {
      return proxyToSandbox(sandboxId, port, request.method, request.remainingPath, request.queryString, request.headers, request.body, false, request.origin, undefined, config.INTERNAL_SERVICE_KEY);
    }

    const resolved = await resolveProvider(sandboxId);
    if (!resolved?.slug) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    // Route through CF Worker: https://{port}--{slug}.{domain}
    const proxyDomain = config.JUSTAVPS_PROXY_DOMAIN;
    const cfProxyUrl = `https://${port}--${resolved.slug}.${proxyDomain}`;

    // Auth: proxy token for CF Worker, service key for core/kortix-master
    const extraHeaders: Record<string, string> = {};
    if (resolved.proxyToken) {
      extraHeaders['X-Proxy-Token'] = resolved.proxyToken;
    }
    const userId = c.get('userId') || '';
    Object.assign(extraHeaders, await buildSignedUserContextHeader(sandboxId, userId, resolved.serviceKey));

    return proxyToSandbox(sandboxId, 8000, request.method, request.remainingPath, request.queryString, request.headers, request.body, false, request.origin, cfProxyUrl, resolved.serviceKey, extraHeaders);
  });

  justavpsOnlyProxy.all('/:sandboxId/:port', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const port = c.req.param('port');
    return c.redirect(`/${sandboxId}/${port}/`, 301);
  });

  sandboxProxyApp.route('/', justavpsOnlyProxy);
} else {
  // ── Multi-provider mode ─────────────────────────────────────────────────
  // Multiple providers enabled: look up the sandbox's provider per request
  // and dispatch to the correct handler.

  const multiProxy = new Hono<{ Variables: { userId: string; userEmail: string } }>();

  multiProxy.all('/:sandboxId/:port/*', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const portStr = c.req.param('port');
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return c.json({ error: `Invalid port: ${portStr}` }, 400);
    }

    const resolved = await resolveProvider(sandboxId);
    const request = await parseProxyRequest(c, sandboxId, port);

    const userId = (c.get('userId') as string) || '';

    if (resolved?.provider === 'local_docker') {
      const extra = await buildSignedUserContextHeader(sandboxId, userId, resolved.serviceKey);
      return proxyToSandbox(sandboxId, port, request.method, request.remainingPath, request.queryString, request.headers, request.body, false, request.origin, undefined, resolved.serviceKey, extra);
    }

    if (resolved?.provider === 'justavps') {
      // JustAVPS: route through CF Worker proxy at {port}--{slug}.{domain}
      const proxyDomain = config.JUSTAVPS_PROXY_DOMAIN;
      const cfProxyUrl = `https://${port}--${resolved.slug}.${proxyDomain}`;
      const extra: Record<string, string> = {};
      if (resolved.proxyToken) {
        extra['X-Proxy-Token'] = resolved.proxyToken;
      }
      Object.assign(extra, await buildSignedUserContextHeader(sandboxId, userId, resolved.serviceKey));
      return proxyToSandbox(sandboxId, 8000, request.method, request.remainingPath, request.queryString, request.headers, request.body, false, request.origin, cfProxyUrl, resolved.serviceKey, extra);
    }

    // Default: route to Daytona preview handler
    return proxyToDaytona(sandboxId, port, userId, request.method, request.remainingPath, request.queryString, request.headers, request.body, request.origin);
  });

  multiProxy.all('/:sandboxId/:port', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const port = c.req.param('port');
    return c.redirect(`/${sandboxId}/${port}/`, 301);
  });

  sandboxProxyApp.route('/', multiProxy);
}

export { sandboxProxyApp };
