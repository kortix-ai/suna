/**
 * `pi-js.kortix.com` — the stable front door for the JS pi agent
 * (apps/pi-worker-js) running as a Platinum Worker cell on Platinum DEV.
 *
 * Same job as pi-router for pi.kortix.com: the cell's own origin
 * (`8080-<cell>.eu-west.sbx-dev.platinum.dev`) is derived from its sandbox id,
 * survives stop/start (the cell scales to zero and cold-boots on the next
 * request) but not a delete + recreate, and is unmemorable either way. The
 * Platinum edge routes by HOSTNAME, so a proxied CNAME cannot carry the name;
 * a Worker rebuilds the request against the target origin.
 *
 * Two things pi-router does not do, because the JS agent has no auth of its
 * own (a request names a session with `?c=` and gets an agent with shell
 * tools):
 *   1. The cell's port is NOT public on the Platinum edge. The edge wants the
 *      exposure token (`?t=` or `x-pt-preview-token`); this Worker injects it
 *      from the PT_PREVIEW_TOKEN secret, so the token never reaches a browser.
 *   2. If ACCESS_TOKEN is set, the public name itself requires
 *      `Authorization: Bearer <ACCESS_TOKEN>` or `x-kortix-access: <ACCESS_TOKEN>`
 *      (the header is consumed here, not forwarded). Unset = open, which is
 *      pi.kortix.com parity — an explicit choice for the operator, not a default
 *      this file makes silently: the 401 body names the missing header.
 *
 * WebSocket upgrades pass through untouched (the agent streams turn events over
 * a socket); SSE/streaming bodies are piped, not buffered.
 */

/** Hop-by-hop headers must not be forwarded; `host` is set by the target URL. */
const STRIPPED = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade-insecure-requests'];
/** Never forwarded: the caller's own credential to THIS name. */
const CONSUMED = ['authorization', 'x-kortix-access'];

/** Constant-time-ish comparison; both sides are short ASCII secrets. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The credential the caller presented for pi-js.kortix.com itself, if any. */
export function presentedAccess(headers) {
  const bearer = headers.get('authorization') || '';
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  return (headers.get('x-kortix-access') || '').trim();
}

/** null = let it through; otherwise the Response to answer with. */
export function accessRefusal(request, env) {
  const required = (env.ACCESS_TOKEN || '').trim();
  if (!required) return null;
  if (sameSecret(presentedAccess(request.headers), required)) return null;
  return Response.json(
    { error: 'pi-js.kortix.com requires Authorization: Bearer <access token> (or x-kortix-access)' },
    { status: 401, headers: { 'www-authenticate': 'Bearer realm="pi-js.kortix.com"' } },
  );
}

export default {
  async fetch(request, env) {
    const target = (env.TARGET_ORIGIN || '').trim();
    if (!target) {
      return Response.json(
        { error: 'pi-js.kortix.com has no target origin configured' },
        { status: 503, headers: { 'retry-after': '30' } },
      );
    }
    const refused = accessRefusal(request, env);
    if (refused) return refused;

    const url = new URL(request.url);
    const upstream = new URL(`${url.pathname}${url.search}`, target);

    const headers = new Headers(request.headers);
    for (const name of STRIPPED) headers.delete(name);
    for (const name of CONSUMED) headers.delete(name);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    // The Platinum edge's exposure token. Accepted as a header so it is never
    // part of a URL a browser could see or a log could keep.
    const previewToken = (env.PT_PREVIEW_TOKEN || '').trim();
    if (previewToken) headers.set('x-pt-preview-token', previewToken);

    let response;
    try {
      response = await fetch(
        new Request(upstream, {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
        }),
      );
    } catch {
      return Response.json(
        { error: 'the pi-js cell is not reachable', target },
        { status: 502, headers: { 'retry-after': '15' } },
      );
    }

    // Cloudflare attaches the accepted socket to this non-standard property.
    // Rebuilding the Response would drop it and break the agent's WebSocket.
    if (response.status === 101 || response.webSocket) return response;

    const output = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    output.headers.set('x-kortix-environment', 'pi-js');
    return output;
  },
};
