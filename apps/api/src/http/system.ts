import { timingSafeEqual } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { config } from '../lib/config';
import { metricsEnabled, renderMetrics } from '../lib/metrics';
import { json, mountOpenApiDocs } from './openapi';
import { mcpProtectedResourceMetadata, oauthAuthorizationServerMetadata } from '../services/oauth/discovery';
import { draining, schemaReady } from '../app/bootstrap';
import { eventLoopLagMs } from '../workers/event-loop-lag';
import { bearerToken } from './lib/bearer';

const MAX_EVENT_LOOP_LAG_MS = Number(process.env.HEALTH_MAX_EVENT_LOOP_LAG_MS || 5000);

export function registerSystemRoutes(app: OpenAPIHono) {
// === Top-Level Health Check (no auth) ===

// Unified platform version (the root VERSION file). Baked into the image via the
// Dockerfile ARG KORTIX_VERSION (dev builds → 0.9.0-dev.<sha8>) and overridden by
// the prod ECS task-def env to the clean X.Y.Z. Deliberately NOT SANDBOX_VERSION —
// that drives snapshot content-hashing and must stay constant across releases.
// Falls back to 'dev' for local development.
const API_VERSION = process.env.KORTIX_VERSION || 'dev';
// Exact source commit the image was built from (baked at build, preserved across
// the prod retag — unlike KORTIX_VERSION which prod overrides to the clean tag).
// Lets the team verify precisely which code is live. 'unknown' for local dev.
const API_COMMIT = process.env.KORTIX_COMMIT || 'unknown';
// When this process booted — confirms a deploy actually rolled fresh pods.
const STARTED_AT = new Date().toISOString();

// OpenAPI spec (/v1/openapi.json) + Scalar API reference (/v1/docs). Typed routes
// register into the spec as each sub-router is migrated to @hono/zod-openapi.
// Internal routers are always stripped from the spec; this flag can suppress
// the whole docs surface for hardened self-host deployments.
if (config.OPENAPI_PUBLIC_DOCS) mountOpenApiDocs(app, API_VERSION);

const HealthSchema = z
  .object({
    status: z.string(),
    service: z.string(),
    timestamp: z.string(),
    environment: z.string(),
    version: z.string(),
    commit: z.string(),
    started_at: z.string(),
  })
  .openapi('Health');

const healthHandler = (c: any) =>
  c.json({
    status: 'ok',
    service: 'kortix-api',
    timestamp: new Date().toISOString(),
    environment: config.INTERNAL_KORTIX_ENV,
    version: API_VERSION,
    commit: API_COMMIT,
    started_at: STARTED_AT,
  });

app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['system'],
    summary: 'Service health (unversioned, used by the load balancer)',
    responses: { 200: json(HealthSchema, 'Service health') },
  }),
  healthHandler,
);

const livenessHandler = (c: any) => {
  const lag = Math.round(eventLoopLagMs);
  if (eventLoopLagMs > MAX_EVENT_LOOP_LAG_MS) {
    // 503 → kubelet liveness fails → the pod is restarted (auto-recovery).
    return c.json(
      {
        status: 'degraded',
        event_loop_lag_ms: lag,
        threshold_ms: MAX_EVENT_LOOP_LAG_MS,
      },
      503,
    );
  }
  return c.json({ status: 'ok', event_loop_lag_ms: lag });
};

// Unversioned + /v1 forms so either can be wired as the kubelet liveness probe.
app.get('/health/live', livenessHandler);
app.get('/v1/health/live', livenessHandler);

// ─── Readiness gate — returns 503 until the app is fully initialized ──────────
//
// The ALB target group health check for ECS Fargate uses this endpoint to
// decide whether a task is ready to receive traffic. During a rolling deploy:
//   1. The new task starts, Bun.serve is up, but schema + services may not be
//      ready yet → returns 503 (ALB keeps it out of the target group).
//   2. Once bootServices() completes → returns 200 (ALB registers it, traffic
//      flows to the new task before the old one is drained).
//   3. On SIGTERM/SIGINT → draining flag is set → returns 503 (ALB deregisters
//      the old task, giving in-flight requests time to complete within the
//      deregistration_delay window).
//
// This eliminates the "brief 503 during deploy" window that caused the
// maintenance mode trigger chain.
const readinessHandler = (c: any) => {
  if (draining) {
    return c.json({ status: 'draining', reason: 'shutdown in progress' }, 503);
  }
  if (!schemaReady) {
    return c.json({ status: 'starting', reason: 'schema not ready' }, 503);
  }
  return c.json({ status: 'ok' });
};
app.get('/health/ready', readinessHandler);
app.get('/v1/health/ready', readinessHandler);

function hasInternalObservabilityAuth(c: any): boolean {
  const bearer = bearerToken(c.req.header('Authorization')) ?? '';
  const header = c.req.header('X-Kortix-Internal-Key') ?? '';
  const expected = config.INTERNAL_SERVICE_KEY;
  const safeEq = (a: string, b: string) => {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  };
  return (!!bearer && safeEq(bearer, expected)) || (!!header && safeEq(header, expected));
}

// Sign in with Kortix — RFC 8414 discovery at the API root. The issuer is the
// configured public API origin (KORTIX_URL); the request origin is only the
// fallback for a bare local run. Mirrored under /v1/oauth/.well-known/… for
// edges that route only /v1/*.
app.get('/.well-known/oauth-authorization-server', (c) => {
  return c.json(oauthAuthorizationServerMetadata(new URL(c.req.url).origin), 200, {
    'cache-control': 'public, max-age=3600',
  });
});

// RFC 9728 protected-resource metadata for the MCP endpoint — what an MCP
// client reads after the endpoint's 401 challenge to find the authorization
// server above.
app.get('/.well-known/oauth-protected-resource/v1/mcp', (c) => {
  return c.json(mcpProtectedResourceMetadata(new URL(c.req.url).origin), 200, {
    'cache-control': 'public, max-age=3600',
  });
});
// Root form of the same document, and the OIDC discovery path some clients
// probe first: both answer with the documents above.
app.get('/.well-known/oauth-protected-resource', (c) => {
  return c.json(mcpProtectedResourceMetadata(new URL(c.req.url).origin), 200, {
    'cache-control': 'public, max-age=3600',
  });
});
app.get('/.well-known/openid-configuration', (c) => {
  return c.json(oauthAuthorizationServerMetadata(new URL(c.req.url).origin), 200, {
    'cache-control': 'public, max-age=3600',
  });
});

app.get('/metrics', (c) => {
  if (!hasInternalObservabilityAuth(c)) {
    return c.text('unauthorized\n', 401);
  }
  if (process.env.KORTIX_LOCAL_TEST_PROFILE === '1') {
    c.header('x-kortix-local-test-profile', '1');
  }
  if (!metricsEnabled()) return c.text('metrics disabled\n', 404);
  c.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  return c.body(renderMetrics());
});

// Health check under /v1 prefix (frontend uses NEXT_PUBLIC_BACKEND_URL which includes /v1)
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/health',
    tags: ['system'],
    summary: 'Service health',
    responses: { 200: json(HealthSchema, 'Service health') },
  }),
  healthHandler,
);
}
