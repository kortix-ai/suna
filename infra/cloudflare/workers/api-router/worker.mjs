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
const AUTOMATIC_MAINTENANCE = {
  ...DEFAULT_MAINTENANCE,
  level: 'blocking',
  title: 'Service maintenance',
  message:
    'Kortix is temporarily unavailable. Service will resume automatically.',
};

// Header a trusted CI run presents to opt OUT of maintenance laundering and see
// the real origin response instead. Compared against the CI_PASSTHROUGH_SECRET
// binding; absent or wrong, the request is treated as ordinary public traffic.
const CI_PASSTHROUGH_HEADER = 'X-Kortix-CI-Passthrough';

// Constant-time over the compared bytes. The length is not secret (a mismatched
// length returns false immediately), the contents are.
function timingSafeEqualStrings(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

// True only when the request carries the exact shared secret. An unset or empty
// binding disables passthrough entirely, so an environment that never sets the
// secret cannot be tricked into revealing origin failures.
function isTrustedCiPassthrough(request, env) {
  const secret = env?.CI_PASSTHROUGH_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const presented = request.headers.get(CI_PASSTHROUGH_HEADER);
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqualStrings(presented, secret);
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

// `originFailure` is set only on the AUTOMATIC path, where a real origin failure
// is being replaced by a synthetic 503. It carries what the origin actually did:
//   status    — the origin HTTP status, or 'fetch-error' when the fetch threw.
//   requestId — the origin's x-request-id, when it sent one.
// Both are surfaced on the response so a failure is diagnosable without
// changing the body every public client already handles.
function maintenanceResponse(config, active, isGateway, request, originFailure) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Retry-After': '30',
    'X-Backend': active,
    'X-Backend-Service': isGateway ? 'gateway' : 'api',
    'X-Maintenance-Mode': 'blocking',
  });
  if (originFailure) {
    headers.set('X-Origin-Status', String(originFailure.status));
    // Restoring the origin's x-request-id is what makes an app-generated 5xx
    // distinguishable from an edge/infrastructure one. Laundering used to erase
    // it, so a genuine application 503 was indistinguishable from an
    // unreachable origin.
    if (originFailure.requestId) {
      headers.set('X-Request-Id', originFailure.requestId);
    }
  }
  if (origin) {
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }

  return addSecurityHeaders(
    new Response(
      JSON.stringify({
        error: 'MAINTENANCE_MODE',
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
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });

    let response;
    try {
      response = await fetch(modifiedRequest);
    } catch {
      // No origin response exists, so there is nothing to pass through even for
      // CI. Say so explicitly instead of leaving the cause unnamed.
      return maintenanceResponse(
        { ...AUTOMATIC_MAINTENANCE, updatedAt: new Date().toISOString() },
        active,
        isGateway,
        request,
        { status: 'fetch-error' },
      );
    }
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      // A trusted CI run needs the real failure, not a maintenance page: the
      // v0.13.0 release gate spent hours reading laundered 503s as a scheduled
      // maintenance window while staging was simply out of capacity. Public
      // traffic still gets the identical synthetic 503 it always got.
      if (isTrustedCiPassthrough(request, env)) {
        const passthrough = new Response(response.body, response);
        passthrough.headers.set('X-Backend', active);
        passthrough.headers.set(
          'X-Backend-Service',
          isGateway ? 'gateway' : 'api',
        );
        passthrough.headers.set('X-Origin-Status', String(response.status));
        return addSecurityHeaders(passthrough);
      }
      return maintenanceResponse(
        { ...AUTOMATIC_MAINTENANCE, updatedAt: new Date().toISOString() },
        active,
        isGateway,
        request,
        {
          status: response.status,
          requestId: response.headers.get('x-request-id'),
        },
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
