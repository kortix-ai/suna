// Kortix API + gateway router — the blue/green cutover switch in front of both
// public services. One worker per env handles BOTH hostnames:
//
//   api.kortix.com          → API      → EKS | EU ECS | US ECS   (ACTIVE_BACKEND)
//   gateway.kortix.com      → gateway  → EKS | EU ECS | US ECS   (GATEWAY_ACTIVE_BACKEND)
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
const MAINTENANCE_LEVELS = new Set([
  'none',
  'info',
  'warning',
  'critical',
  'blocking',
]);
const DEFAULT_MAINTENANCE = {
  level: 'none',
  title: '',
  message: '',
  startTime: null,
  endTime: null,
  statusUrl: null,
  affectedServices: [],
  updatedAt: new Date(0).toISOString(),
};
// Origin errors are NEVER rewritten. Until 2026-08-24 this worker replaced
// every origin 502/503/504 with a synthetic "Service maintenance" 503, which
// hid the real failure from users, from OpenCode's retry classifier and from
// whoever was debugging: a gateway content-encoding bug surfaced on dev as
// "Kortix is temporarily unavailable" for days while the gateway logged 200s.
// A blocking maintenance page now comes ONLY from an explicit admin state
// (readMaintenanceConfig). Everything the origin says passes through with
// its status, body and headers intact; only an origin that cannot be reached
// at all gets a synthetic response, and that one names itself.
const WEBHOOK_RELAY_USER_AGENT = 'Kortix-Webhook-Relay/1.0';

// The one synthetic error this worker still produces: the origin fetch threw
// (DNS, TLS, connection refused, timeout). 503 + Retry-After marks it
// transient for retrying clients; 503 rather than 502 because Cloudflare
// rewrites a 502/504 body into its HTML error page and this JSON must reach
// the client. There is deliberately no x-request-id: no origin request ran.
function originUnreachableResponse(active, isGateway, request, reason) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Retry-After': '30',
    'X-Backend': active,
    'X-Backend-Service': isGateway ? 'gateway' : 'api',
    'X-Origin-Status': 'fetch-error',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  const message = `Kortix ${isGateway ? 'gateway' : 'API'} origin is unreachable: ${reason}`;
  return addSecurityHeaders(
    Response.json(
      {
        error: { message, type: 'origin_unreachable', code: 'origin_unreachable' },
        message,
        code: 'origin_unreachable',
        retry_after_seconds: 30,
      },
      { status: 503, headers },
    ),
  );
}

function addSecurityHeaders(response) {
  response.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

function isReadOnlyRequest(request) {
  return (
    request.method === 'GET' ||
    request.method === 'HEAD' ||
    request.method === 'OPTIONS'
  );
}

function isWebhookIngressRequest(request, url) {
  if (request.method !== 'POST') return false;
  return (
    url.pathname.startsWith('/v1/webhooks/') ||
    url.pathname.startsWith('/v1/billing/webhook/') ||
    url.pathname.startsWith('/v1/billing/webhooks/') ||
    url.pathname === '/v1/connectors/webhook/pipedream'
  );
}

async function readMaintenanceConfig(env) {
  if (env.MAINTENANCE_LEVEL_OVERRIDE === 'blocking') {
    return {
      ...DEFAULT_MAINTENANCE,
      level: 'blocking',
      title: env.MAINTENANCE_TITLE_OVERRIDE || 'Scheduled maintenance',
      message:
        env.MAINTENANCE_MESSAGE_OVERRIDE ||
        'Kortix is temporarily unavailable for maintenance.',
      updatedAt: new Date().toISOString(),
    };
  }

  if (!env.MAINTENANCE_STATE_URL) return null;

  try {
    const response = await fetch(env.MAINTENANCE_STATE_URL, {
      headers: { Accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: 2 },
    });
    if (!response.ok) {
      // State URL is unreachable or errored — return null so the router
      // does not enter maintenance mode. A transient Vercel/Edge Config
      // blip should not cause a full lockdown.
      return null;
    }

    const config = await response.json();
    if (!config || !MAINTENANCE_LEVELS.has(config.level)) {
      return null;
    }
    return { ...DEFAULT_MAINTENANCE, ...config };
  } catch {
    // Network error reaching the state URL — fail open, not closed.
    // A blocking lockdown should only result from an explicit admin
    // action persisted in DB + Edge Config, never from a transient
    // fetch failure.
    return null;
  }
}

function maintenanceResponse(config, active, isGateway, request) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Retry-After': '30',
    'X-Backend': active,
    'X-Backend-Service': isGateway ? 'gateway' : 'api',
    'X-Maintenance-Mode': 'blocking',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }

  return addSecurityHeaders(
    new Response(
      JSON.stringify({
        // `error` is an OBJECT, not a string: the AI-SDK gateway client
        // (@ai-sdk/gateway, the default sandbox LLM path since #6631) parses
        // non-2xx bodies against `{ error: { message, type, code } }`. The old
        // string shape failed that schema, so every laundered origin 5xx
        // surfaced in a session as the information-free "Invalid error
        // response format: Gateway request failed" instead of a retryable
        // maintenance signal (SESS-23, run 32330628092). The MAINTENANCE_MODE
        // token stays in `type`/`code`, so every substring detector still
        // fires; header detection (`x-maintenance-mode`) is unchanged.
        error: {
          message:
            config.message ||
            'Kortix is temporarily unavailable for maintenance.',
          type: 'MAINTENANCE_MODE',
          code: 'MAINTENANCE_MODE',
        },
        message:
          config.message ||
          'Kortix is temporarily unavailable for maintenance.',
        maintenance: config,
      }),
      { status: 503, headers },
    ),
  );
}

function maintenanceConfigResponse(config, active, source) {
  return addSecurityHeaders(
    new Response(JSON.stringify(config), {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=2, must-revalidate',
        'Content-Type': 'application/json',
        'X-Backend': active,
        'X-Backend-Service': 'router',
        'X-Maintenance-Source': source,
      },
    }),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isGateway = url.hostname.includes('gateway');

    const active =
      (isGateway ? env.GATEWAY_ACTIVE_BACKEND : env.ACTIVE_BACKEND) || 'ecs-fargate';
    const backends = isGateway
      ? {
          eks: env.GATEWAY_BACKEND_EKS,
          'ecs-fargate': env.GATEWAY_BACKEND_ECS_FARGATE,
          'us-east-2': env.GATEWAY_BACKEND_US_EAST_2,
        }
      : {
          eks: env.BACKEND_EKS,
          'ecs-fargate': env.BACKEND_ECS_FARGATE,
          'us-east-2': env.BACKEND_US_EAST_2,
        };

    const backendUrl = backends[active];
    if (!backendUrl) {
      const svc = isGateway ? 'gateway' : 'api';
      return new Response(`Invalid ${svc} backend configuration: ${active}`, {
        status: 500,
      });
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
    const isMaintenanceConfigRead =
      !isGateway &&
      request.method === 'GET' &&
      url.pathname === '/v1/system/maintenance';

    if (isMaintenanceConfigRead) {
      try {
        const primaryResponse = await fetch(
          new Request(targetUrl, {
            method: 'GET',
            headers: request.headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(2_000),
          }),
        );
        if (primaryResponse.ok) {
          const primaryConfig = await primaryResponse.json();
          if (primaryConfig && MAINTENANCE_LEVELS.has(primaryConfig.level)) {
            return maintenanceConfigResponse(
              { ...DEFAULT_MAINTENANCE, ...primaryConfig },
              active,
              'database',
            );
          }
        }
      } catch {
        // The independent store or automatic blocking response is returned below.
      }

      const fallback = await readMaintenanceConfig(env);
      if (fallback) {
        return maintenanceConfigResponse(fallback, active, 'edge-config');
      }
      // Both API and Edge Config are unreachable — return a safe default.
      // Prefer none to blocking so a transient API blip (deploy, GC pause)
      // doesn't flood every user with the maintenance page. If the admin
      // truly intended a lockdown, it persists in Edge Config and this
      // path won't be reached.
      return maintenanceConfigResponse(
        { ...DEFAULT_MAINTENANCE, updatedAt: new Date().toISOString() },
        active,
        'automatic',
      );
    }

    const maintenance = await readMaintenanceConfig(env);
    const isMaintenanceConfigWrite =
      !isGateway &&
      request.method === 'PUT' &&
      url.pathname === '/v1/system/maintenance';

    if (
      maintenance?.level === 'blocking' &&
      !isReadOnlyRequest(request) &&
      !isMaintenanceConfigWrite
    ) {
      return maintenanceResponse(maintenance, active, isGateway, request);
    }

    // `manual` so backend 3xx responses are passed straight through to the
    // browser. With `follow`, the worker would chase a browser-facing redirect
    // server-side (no client cookies) — e.g. the Slack OAuth callback's
    // `302 → kortix.com/projects/...` got followed here, kortix.com bounced to
    // /auth, and the worker returned that /auth HTML as a 200, so the browser
    // never saw the redirect (blank page, URL stuck on the callback).
    const originHeaders = new Headers(request.headers);
    // AWSManagedRulesCommonRuleSet rejects a missing User-Agent before the API
    // can verify the webhook signature. External webhook providers are not
    // required to send this informational header. Supply a relay identity only
    // on public POST webhook routes and only when the sender omitted the header.
    if (
      !isGateway &&
      isWebhookIngressRequest(request, url) &&
      !originHeaders.has('User-Agent')
    ) {
      originHeaders.set('User-Agent', WEBHOOK_RELAY_USER_AGENT);
    }
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: originHeaders,
      body: request.body,
      redirect: 'manual',
    });

    let response;
    try {
      response = await fetch(modifiedRequest);
    } catch (error) {
      return originUnreachableResponse(
        active,
        isGateway,
        request,
        error instanceof Error && error.message ? error.message : 'fetch failed',
      );
    }
    // Cloudflare attaches the accepted socket to response.webSocket. Creating
    // a new Response drops that non-standard property and breaks the upgrade.
    if (response.status === 101 || response.webSocket) {
      return response;
    }
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Backend', active);
    newResponse.headers.set('X-Backend-Service', isGateway ? 'gateway' : 'api');
    return addSecurityHeaders(newResponse);
  },
};
