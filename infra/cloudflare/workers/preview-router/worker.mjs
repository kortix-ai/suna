/**
 * Sandbox preview edge — `{env}-p{port}-{sandbox}.p.kortix.com`.
 *
 * Every sandbox port a user can open in a browser gets its own ORIGIN. That is
 * what makes an arbitrary app work unmodified: it sees itself at `/`, so
 * root-absolute links, `fetch('/api')`, `history.pushState`, CSS `url(/x.png)`,
 * service workers and WebSockets all resolve to the origin the browser is on.
 * A path prefix cannot offer that.
 *
 * One wildcard covers every environment, so the environment is the first label
 * segment and decides which API origin the request is forwarded to. The
 * forward loses the public hostname, so this Worker re-states it in a header
 * and SIGNS it — otherwise anyone who can reach the API origin could name any
 * preview. See apps/api/src/shared/edge-signature.ts for the verifier.
 *
 * Mirrors infra/cloudflare/workers/apps-router/worker.mjs; the two edges differ
 * only in hostname shape and header names.
 */
const ENVIRONMENTS = new Set(['dev', 'staging', 'prod', 'preview']);

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

export async function signPreviewRequest(request, timestamp, secret) {
  const url = new URL(request.url);
  return hmac(
    secret,
    `${timestamp}\n${url.hostname.toLowerCase()}\n${request.method.toUpperCase()}\n${url.pathname}${url.search}`,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const selected = backendFor(url.hostname.toLowerCase(), env);
    if (!selected?.backend) {
      return Response.json({ error: 'Invalid Kortix preview environment' }, { status: 404 });
    }
    const edgeSecret = edgeSecretFor(selected.environment, env);
    if (!edgeSecret) {
      return Response.json({ error: 'Kortix preview edge is not configured' }, { status: 503 });
    }

    const target = new URL(`${url.pathname}${url.search}`, selected.backend);
    const timestamp = String(Date.now());
    const headers = new Headers(request.headers);
    // A client must never be able to hand itself the edge's authority by
    // naming these headers; the Worker is the only thing that may set them.
    headers.delete('x-kortix-preview-host');
    headers.delete('x-kortix-preview-timestamp');
    headers.delete('x-kortix-preview-signature');
    headers.set('x-kortix-preview-host', url.hostname);
    headers.set('x-kortix-preview-timestamp', timestamp);
    headers.set('x-kortix-preview-signature', await signPreviewRequest(request, timestamp, edgeSecret));
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');

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
        { error: 'Kortix preview control plane is unavailable' },
        { status: 503, headers: { 'retry-after': '5' } },
      );
    }

    // Cloudflare attaches the accepted socket to this non-standard property.
    // Constructing a new Response would drop it and break WebSocket upgrades —
    // which a dev server's hot reload depends on.
    if (response.status === 101 || response.webSocket) return response;

    const output = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    output.headers.set('x-kortix-preview-environment', selected.environment);
    return output;
  },
};
