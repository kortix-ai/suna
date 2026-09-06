/**
 * `pi.kortix.com` — the stable front door for the pi-worker branch environment.
 *
 * The environment lives in a Platinum sandbox whose own origin
 * (`8080-<sandbox>.eu-west.sbx.platinum.dev`) is derived from the sandbox id.
 * That id survives a redeploy but NOT a rebuild of the sandbox, and it is
 * unmemorable either way. This Worker gives the environment one name that never
 * changes, exactly as `dev.kortix.com` does for dev.
 *
 * A proxied CNAME cannot do this job: the Platinum edge routes by HOSTNAME, so
 * it needs `Host` (and TLS SNI) to name the sandbox, while the browser is
 * asking for `pi.kortix.com`. Host-header override is Enterprise-only. A Worker
 * rewrites both for free by building the request against the target origin.
 *
 * TARGET_ORIGIN is a plain var, re-published by the deploy workflow on every
 * deploy, so re-pointing the name at a rebuilt sandbox needs no code change.
 */

/** Hop-by-hop headers must not be forwarded; `host` is set by the target URL. */
const STRIPPED = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade-insecure-requests'];

export default {
  async fetch(request, env) {
    const target = (env.TARGET_ORIGIN || '').trim();
    if (!target) {
      return Response.json(
        { error: 'pi.kortix.com has no target origin configured' },
        { status: 503, headers: { 'retry-after': '30' } },
      );
    }

    const url = new URL(request.url);
    // The origin is ALWAYS the configured target: copy the path and query onto
    // it, never resolve the incoming path against it. `//host/x` is a
    // scheme-relative reference — `new URL('//evil/x', target)` would have sent
    // the request to evil (found by the Strix review of #7125, CWE-918).
    if (/^\/[\/\\]/.test(url.pathname)) {
      return Response.json({ error: 'invalid path' }, { status: 400 });
    }
    const upstream = new URL(target);
    upstream.pathname = url.pathname;
    upstream.search = url.search;

    const headers = new Headers(request.headers);
    for (const name of STRIPPED) headers.delete(name);
    // The stack is CONFIGURED with https://pi.kortix.com, and Next's Server
    // Action guard compares `x-forwarded-host` with `origin`. Caddy inside the
    // sandbox pins this too; state it here so the value is right even if a
    // request reaches something ahead of Caddy.
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');

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
        { error: 'the pi environment is not reachable', target },
        { status: 502, headers: { 'retry-after': '15' } },
      );
    }

    // Cloudflare attaches the accepted socket to this non-standard property.
    // Rebuilding the Response would drop it and break WebSocket upgrades, which
    // Supabase Realtime and Next's dev overlay both use.
    if (response.status === 101 || response.webSocket) return response;

    // Streaming `response.body` straight through is what keeps SSE — the
    // session event feed — from being buffered until the turn ends.
    const output = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    output.headers.set('x-kortix-environment', 'pi');
    return output;
  },
};
