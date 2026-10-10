const ENVIRONMENTS = new Set(['dev', 'staging', 'prod', 'preview']);
const APP_FRAME_ANCESTORS =
  "frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*";

function withoutFrameAncestors(value) {
  return value
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive));
}

function embeddableAppHeaders(upstreamHeaders) {
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

function backendFor(hostname, env) {
  const environment = hostname.split('-', 1)[0];
  if (!ENVIRONMENTS.has(environment)) return null;
  return {
    environment,
    backend: {
      dev: env.DEV_API_ORIGIN,
      staging: env.STAGING_API_ORIGIN,
      prod: env.PROD_API_ORIGIN,
      preview: env.PREVIEW_API_ORIGIN,
    }[environment],
  };
}

function edgeSecretFor(environment, env) {
  return {
    dev: env.DEV_EDGE_SECRET,
    staging: env.STAGING_EDGE_SECRET,
    prod: env.PROD_EDGE_SECRET,
    preview: env.PREVIEW_EDGE_SECRET,
  }[environment] || env.EDGE_SECRET;
}

async function hmac(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function signAppRequest(request, timestamp, secret) {
  const url = new URL(request.url);
  return hmac(
    secret,
    `${timestamp}\n${url.hostname.toLowerCase()}\n${request.method.toUpperCase()}\n${url.pathname}${url.search}`,
  );
}

// Edge cache for public static App files. The API marks a response shareable
// (EDGE_CACHEABLE) only for a public static App; an App's own headers cannot.
// The Worker stores only marked, immutable, cookie-free 200s, keyed on the App
// host, path, query, and negotiated encoding. The edge TTL bounds how long a
// copy outlives a public-to-private switch or an App deletion: there is no purge.
const EDGE_CACHEABLE = 'x-kortix-edge-cacheable';
const BROWSER_CACHE_CONTROL = 'x-kortix-browser-cache-control';
const EDGE_TTL_SECONDS = 3600;

/** The encoding the API will choose for this client, by the API's own rule. */
function edgeEncoding(acceptEncoding) {
  const accepted = (acceptEncoding || '').toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return 'identity';
}

/** The cache entry for a cacheable request, or null for one the edge never answers. */
function edgeCacheEntry(request, url) {
  if (typeof caches === 'undefined' || request.method !== 'GET') return null;
  if (request.headers.has('range') || request.headers.has('upgrade')) return null;
  const encoding = edgeEncoding(request.headers.get('accept-encoding'));
  const key = `${url.origin}${url.pathname}${url.search}${url.search ? '&' : '?'}__kortix_enc=${encoding}`;
  return { encoding, key: new Request(key) };
}

function edgeStorable(response) {
  const headers = response.headers;
  const cacheControl = (headers.get('cache-control') || '').toLowerCase().split(',').map((part) => part.trim());
  const vary = (headers.get('vary') || '').toLowerCase().split(',').map((part) => part.trim()).filter(Boolean);
  return response.status === 200
    && headers.get(EDGE_CACHEABLE) === 'public'
    && cacheControl.includes('public')
    && cacheControl.includes('immutable')
    && !headers.has('set-cookie')
    && vary.every((name) => name === 'accept-encoding');
}

function fromEdge(hit) {
  const output = new Response(hit.body, hit);
  output.headers.set('cache-control', output.headers.get(BROWSER_CACHE_CONTROL) || 'public, max-age=0, must-revalidate');
  output.headers.delete(BROWSER_CACHE_CONTROL);
  output.headers.set('x-kortix-edge-cache', 'HIT');
  return output;
}

function edgeCopy(response) {
  const copy = new Response(response.clone().body, response);
  copy.headers.set(BROWSER_CACHE_CONTROL, response.headers.get('cache-control'));
  copy.headers.set('cache-control', `public, max-age=${EDGE_TTL_SECONDS}`);
  copy.headers.delete('x-kortix-edge-cache');
  copy.headers.delete(EDGE_CACHEABLE);
  return copy;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const selected = backendFor(url.hostname.toLowerCase(), env);
    if (!selected?.backend) {
      return Response.json({ error: 'Invalid Kortix App environment' }, { status: 404 });
    }
    const edgeSecret = edgeSecretFor(selected.environment, env);
    if (!edgeSecret) {
      return Response.json({ error: 'Kortix Apps edge is not configured' }, { status: 503 });
    }
    const edge = edgeCacheEntry(request, url);
    if (edge) {
      const hit = await caches.default.match(edge.key).catch(() => undefined);
      if (hit) return fromEdge(hit);
    }
    const target = new URL(`${url.pathname}${url.search}`, selected.backend);
    const timestamp = String(Date.now());
    const headers = new Headers(request.headers);
    headers.delete('x-kortix-app-host');
    headers.delete('x-kortix-app-timestamp');
    headers.delete('x-kortix-app-signature');
    headers.set('x-kortix-app-host', url.hostname);
    headers.set('x-kortix-app-timestamp', timestamp);
    headers.set('x-kortix-app-signature', await signAppRequest(request, timestamp, edgeSecret));
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    // The API zone refuses a request with no User-Agent (403). Node's `ws`
    // client sends none, so the Convex CLI and server-side clients need one.
    if (!headers.get('user-agent')) headers.set('user-agent', 'kortix-apps-router');
    // One stored variant per encoding: ask the API for exactly that encoding.
    if (edge) headers.set('accept-encoding', edge.encoding);

    let response;
    try {
      response = await fetch(new Request(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
      }));
    } catch {
      return Response.json(
        { error: 'Kortix App control plane is unavailable' },
        { status: 503, headers: { 'retry-after': '5' } },
      );
    }
    // Cloudflare attaches the accepted socket to this non-standard property.
    // Constructing a new Response would drop it and break WebSocket upgrades.
    if (response.status === 101 || response.webSocket) return response;
    const output = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: embeddableAppHeaders(response.headers),
    });
    output.headers.set('x-kortix-app-environment', selected.environment);
    output.headers.delete('cloudflare-cdn-cache-control');
    if (edge) {
      output.headers.set('x-kortix-edge-cache', 'MISS');
      if (edgeStorable(output)) {
        const stored = caches.default.put(edge.key, edgeCopy(output)).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(stored);
      }
    }
    output.headers.delete(EDGE_CACHEABLE);
    return output;
  },
};
