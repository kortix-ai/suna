// Kortix API + gateway router — the blue/green cutover switch in front of both
// public services. One worker per env handles BOTH hostnames:
//
//   api.kortix.com          → API      → EKS | ECS-Fargate   (ACTIVE_BACKEND)
//   gateway.kortix.com      → gateway  → EKS | ECS-Fargate   (GATEWAY_ACTIVE_BACKEND)
//   (staging-/dev- variants route to the "staging"/"dev" worker envs)
//
// The service is chosen by hostname (anything containing "gateway" is the LLM
// gateway); each service has its OWN active-backend var + origin pair, so the
// API and the gateway can be flipped or rolled back INDEPENDENTLY from this one
// router with no DNS change. Both backends of a service run the same image
// against the same DB, so a flip is safe (background-worker leadership is a
// single global DB lease — see apps/api/src/shared/leader-election.ts — so only
// one side ever runs cron). Flipping is instant and instantly reversible.
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

function addSecurityHeaders(response) {
  response.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isGateway = url.hostname.includes('gateway');

    const active = (isGateway ? env.GATEWAY_ACTIVE_BACKEND : env.ACTIVE_BACKEND) || 'eks';
    const backends = isGateway
      ? { eks: env.GATEWAY_BACKEND_EKS, 'ecs-fargate': env.GATEWAY_BACKEND_ECS_FARGATE }
      : { eks: env.BACKEND_EKS, 'ecs-fargate': env.BACKEND_ECS_FARGATE };

    const backendUrl = backends[active];
    if (!backendUrl) {
      const svc = isGateway ? 'gateway' : 'api';
      return new Response(`Invalid ${svc} backend configuration: ${active}`, { status: 500 });
    }

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
    newResponse.headers.set('X-Backend-Service', isGateway ? 'gateway' : 'api');
    return addSecurityHeaders(newResponse);
  },
};
