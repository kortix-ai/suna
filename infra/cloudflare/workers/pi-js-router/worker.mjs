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
 *   2. The name FAILS CLOSED unless the deploy says otherwise. OPEN_ACCESS=true
 *      (a plain var, visible in the deploy command) opens it — pi.kortix.com
 *      parity, chosen by the operator; the workflow also deletes any stored
 *      bearer. Otherwise ACCESS_TOKEN must be set and every request must carry
 *      `Authorization: Bearer <ACCESS_TOKEN>` or `x-kortix-access: <ACCESS_TOKEN>`
 *      (consumed here, never forwarded); with neither the Worker answers 503,
 *      not an open door a cleared secret can fall into (Strix on #7125, CWE-306).
 *
 * The same Worker fronts a full Kortix branch environment when the deploy says
 * so (deploy-pi-js-router.yml `target_kind=stack`): that sandbox's 8080 is
 * exposed PUBLIC and the stack authenticates its own users, so the deploy
 * stores no PT_PREVIEW_TOKEN (nothing is injected) and sets OPEN_ACCESS=true —
 * pi-router's posture. No code path below changes; only what is stored does.
 *
 * The upstream URL is built from the TARGET origin and then given the incoming
 * path and query — never by resolving the incoming path against the origin. A
 * path that starts with `//` is a scheme-relative reference, and
 * `new URL('//evil/x', target)` would send the request — with the exposure
 * token attached — to evil. Such paths are refused with 400 (CWE-918).
 *
 * WebSocket upgrades pass through untouched (the agent streams turn events over
 * a socket); SSE/streaming bodies are piped, not buffered.
 */

/** Hop-by-hop headers must not be forwarded; `host` is set by the target URL. */
const STRIPPED = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade-insecure-requests'];
/** Response headers that describe a body this Worker no longer passes through verbatim. */
export const PASSTHROUGH_STRIPPED = ['content-encoding', 'content-length'];
/**
 * Never forwarded: the caller's own credential to THIS name — but ONLY when this
 * name asked for one. In ACCESS_TOKEN mode the bearer that opened the door is
 * consumed here. With OPEN_ACCESS=true nothing was asked for, so an
 * Authorization header belongs to the ORIGIN: the Kortix stack behind
 * pi-js.kortix.com authenticates its own users with a Supabase JWT in exactly
 * that header, and deleting it unconditionally turned every signed-in call into
 * the API's "Missing or invalid Authorization header" (2026-09-05, the owner
 * could not sign in with email). `x-kortix-access` is this Worker's own header
 * and is never meaningful upstream, so it is always dropped.
 */
const ALWAYS_CONSUMED = ['x-kortix-access'];
export function consumedHeaders(env) {
  const openAccess = (env.OPEN_ACCESS || '').trim() === 'true';
  return openAccess ? ALWAYS_CONSUMED : [...ALWAYS_CONSUMED, 'authorization'];
}

/** Constant-time-ish comparison; both sides are short ASCII secrets. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The upstream URL for an incoming request URL, or null when the path must not
 * be forwarded. The origin is ALWAYS the configured target: the path and query
 * are copied onto it, never resolved against it.
 */
export function upstreamUrl(target, requestUrl) {
  const incoming = new URL(requestUrl);
  // `//host/...` and `/\host/...` are scheme-relative to a URL parser; a proxy
  // that resolved them would leave its own origin. Nothing legitimate here
  // starts a path that way.
  if (/^\/[\/\\]/.test(incoming.pathname)) return null;
  const upstream = new URL(target);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  upstream.hash = '';
  return upstream;
}

/** The credential the caller presented for pi-js.kortix.com itself, if any. */
export function presentedAccess(headers) {
  const bearer = headers.get('authorization') || '';
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  return (headers.get('x-kortix-access') || '').trim();
}

/**
 * null = let it through; otherwise the Response to answer with.
 * Fails closed: no ACCESS_TOKEN and no explicit OPEN_ACCESS=true is a 503, not
 * an open door in front of a shell-capable agent.
 */
export function accessRefusal(request, env) {
  const required = (env.ACCESS_TOKEN || '').trim();
  const openAccess = (env.OPEN_ACCESS || '').trim() === 'true';
  // OPEN_ACCESS=true is the operator's explicit, visible choice at deploy time
  // (a plain var in the deploy command) and wins even over a bearer that is
  // still stored: the owner opened the name on 2026-09-05 and the stored
  // bearer kept answering 401. Deleting the secret is the workflow's job; the
  // Worker must not keep a door shut that the deploy said to open.
  if (openAccess) return null;
  if (!required) {
    return Response.json(
      { error: 'pi-js.kortix.com is not configured: set the ACCESS_TOKEN secret, or deploy with OPEN_ACCESS=true to run it open' },
      { status: 503, headers: { 'retry-after': '60' } },
    );
  }
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

    const upstream = upstreamUrl(target, request.url);
    if (!upstream) return Response.json({ error: 'invalid path' }, { status: 400 });

    const headers = new Headers(request.headers);
    for (const name of STRIPPED) headers.delete(name);
    for (const name of consumedHeaders(env)) headers.delete(name);
    // ASK THE ORIGIN FOR PLAIN BYTES. This Worker rebuilds the response
    // (`new Response(response.body, …)`), and a rebuilt body is one Cloudflare
    // may compress on its way to the client — on top of the origin's own gzip,
    // while `content-encoding: gzip` still says "compressed once". The client
    // then gunzips once and reads compressed bytes: `Decompression error:
    // ZlibError`, which is what every agent turn on pi-js.kortix.com hit
    // (2026-09-05, sandbox pt-app.log; the turn retried three times and gave
    // up, so a message got no answer). A plain browser GET survived it, which
    // is why the name looked healthy. Identity upstream + no encoding headers
    // below leaves exactly one party compressing: Cloudflare, for the client
    // that asked.
    headers.set('accept-encoding', 'identity');
    headers.set('x-forwarded-host', new URL(request.url).host);
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
          // A streaming request body needs this on every runtime but
          // Cloudflare's, which ignores it. Without it the same code refuses a
          // POST under Node/undici, so the LLM path — the only POST that
          // matters here — could not be claimed off-platform.
          duplex: 'half',
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
    // The body leaving here is what the origin sent under `accept-encoding:
    // identity`: not encoded, and its length is Cloudflare's to state once it
    // has chosen an encoding for the client. Carrying either header forward
    // describes a body that no longer exists.
    for (const name of PASSTHROUGH_STRIPPED) output.headers.delete(name);
    output.headers.set('x-kortix-environment', 'pi-js');
    return output;
  },
};
