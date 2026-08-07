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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const selected = backendFor(url.hostname.toLowerCase(), env);
    if (!selected?.backend) {
      return Response.json({ error: 'Invalid Kortix App environment' }, { status: 404 });
    }
    if (!env.EDGE_SECRET) {
      return Response.json({ error: 'Kortix Apps edge is not configured' }, { status: 503 });
    }
    const target = new URL(`${url.pathname}${url.search}`, selected.backend);
    const timestamp = String(Date.now());
    const headers = new Headers(request.headers);
    headers.delete('x-kortix-app-host');
    headers.delete('x-kortix-app-timestamp');
    headers.delete('x-kortix-app-signature');
    headers.set('x-kortix-app-host', url.hostname);
    headers.set('x-kortix-app-timestamp', timestamp);
    headers.set('x-kortix-app-signature', await signAppRequest(request, timestamp, env.EDGE_SECRET));
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
        { error: 'Kortix App control plane is unavailable' },
        { status: 503, headers: { 'retry-after': '5' } },
      );
    }
    // Cloudflare attaches the accepted socket to this non-standard property.
    // Constructing a new Response would drop it and break WebSocket upgrades.
    if (response.status === 101 || response.webSocket) return response;
    const output = new Response(response.body, response);
    output.headers.set('x-kortix-app-environment', selected.environment);
    return output;
  },
};
