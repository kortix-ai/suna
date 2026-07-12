// Kortix API router — the blue/green cutover switch in front of the public API.
//
//   api.kortix.com          → this worker (env "prod")    → EKS | ECS-Fargate
//   staging-api.kortix.com  → this worker (env "staging") → EKS | ECS-Fargate
//   dev-api.kortix.com      → this worker (env "dev")     → EKS | ECS-Fargate
//
// The active backend is chosen by the `ACTIVE_BACKEND` plain-text var; the two
// concrete origins are `BACKEND_EKS` / `BACKEND_ECS_FARGATE` (per-env vars in
// wrangler.toml). Flipping ACTIVE_BACKEND is an instant, instantly-reversible
// failover with no DNS change. Both backends run the same image against the same
// DB, so a flip is safe (background-worker leadership is a single global DB lease
// — see apps/api/src/shared/leader-election.ts — so only one side ever runs cron).
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

function addSecurityHeaders(response) {
  response.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export default {
  async fetch(request, env) {
    const active = env.ACTIVE_BACKEND || 'eks';

    const backends = {
      eks: env.BACKEND_EKS,
      'ecs-fargate': env.BACKEND_ECS_FARGATE,
    };

    const backendUrl = backends[active];
    if (!backendUrl) {
      return new Response(`Invalid backend configuration: ${active}`, { status: 500 });
    }

    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return new Response(null, {
        status: 308,
        headers: {
          Location: url.toString(),
        },
      });
    }

    const targetUrl = new URL(url.pathname + url.search, backendUrl);

    // `manual` so backend 3xx responses are passed straight through to the
    // browser. With `follow`, the worker would chase a browser-facing redirect
    // server-side (no client cookies) — e.g. the Slack OAuth callback's
    // `302 → kortix.com/projects/...` got followed here, kortix.com bounced to
    // /auth, and the worker returned that /auth HTML as a 200, so the browser
    // never saw the redirect (blank page, URL stuck on the callback).
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });

    const response = await fetch(modifiedRequest);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Backend', active);
    return addSecurityHeaders(newResponse);
  },
};
