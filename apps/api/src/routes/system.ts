import { timingSafeEqual } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { config } from '../config';
import { apiRegion, databaseRegion } from '../lib/deployment-region';
import { setEventLoopLagSeconds, metricsEnabled, renderMetrics } from '../lib/metrics';
import { sendDemoRequestNotification } from '../lib/demo-request-email';
import { auth, errors, json, mountOpenApiDocs } from '../openapi';
import { createDemoRequestRateLimitMiddleware } from '../shared/rate-limit';
import { platformSettings } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { isLeader } from '../shared/leader-election';
import { getTriggerSchedulerHealth } from '../projects';
import { oauthAuthorizationServerMetadata, mcpProtectedResourceMetadata } from '../oauth/discovery';
import { isUuid } from '../shared/validate';
import { db, hasDatabase } from '../shared/db';
import { computeEtag, etagMatches } from '../shared/http-cache';
import { supabaseAuth } from '../middleware/auth';
import { getPlatformRole } from '../shared/platform-roles';
import { readJsonObject } from '../shared/http-body';

export function registerSystemRoutes(app: OpenAPIHono, readiness: { draining(): boolean; schemaReady(): boolean }) {
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
// Which replica answered (pod name in k8s, task/container id in ECS).
const API_INSTANCE = process.env.HOSTNAME || 'unknown';

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
    instance: z.string(),
    scheduler_leader: z.boolean(),
    trigger_scheduler: z.record(z.string(), z.unknown()),
    // Best-effort deployment topology, resolved once at import time (see
    // lib/deployment-region.ts). the turn-latency spec (PR #7840)'s own baseline
    // turned out to be dominated by a us-west-2 API against a us-east-2
    // database, not by the code path — this lets `pnpm test -- --latency`
    // report WHERE the two halves live instead of just a duration. Neither
    // field is sensitive: an AWS region name, never a host, user, or secret.
    region: z.string().nullable(),
    database_region: z.string().nullable(),
  })
  .openapi('Health');

// Resolved once: neither AWS_REGION nor DATABASE_URL changes for the life of
// the process, so there is no reason to re-parse it on every /health poll.
const API_REGION = apiRegion();
const DATABASE_REGION = databaseRegion(config.DATABASE_URL);

const healthHandler = (c: any) =>
  c.json({
    status: 'ok',
    service: 'kortix-api',
    timestamp: new Date().toISOString(),
    environment: config.INTERNAL_KORTIX_ENV,
    version: API_VERSION,
    commit: API_COMMIT,
    started_at: STARTED_AT,
    instance: API_INSTANCE,
    scheduler_leader: isLeader(),
    trigger_scheduler: getTriggerSchedulerHealth(),
    region: API_REGION,
    database_region: DATABASE_REGION,
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

// ─── Event-loop lag monitor → a real liveness signal ─────────────────────────
//
// The /health handlers above answer in <1ms even when the event loop is badly
// degraded. During the 2026-06-18 incident that meant k8s liveness NEVER fired
// and wedged pods were never restarted — a 90-minute outage instead of a ~45s
// self-heal. This samples ACTUAL event-loop lag (a healthy loop drifts a few ms;
// a starved one drifts into seconds) and exposes it at /health/live so a
// degraded-but-not-dead pod can be detected and restarted by the kubelet.
//
// NOTE: the chart's livenessProbe still points at the shallow /v1/health by
// default — flip health.livenessPath to /health/live only AFTER an image that
// serves this route is confirmed live (otherwise old pods 404 their liveness
// probe and crash-loop). See infra/k8s/charts/kortix-api.
const MAX_EVENT_LOOP_LAG_MS = Number(process.env.HEALTH_MAX_EVENT_LOOP_LAG_MS || 5000);
let eventLoopLagMs = 0;
{
  const SAMPLE_INTERVAL_MS = 1000;
  let lastSample = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    // How much longer than the interval the loop took to come back to this tick.
    eventLoopLagMs = Math.max(0, now - lastSample - SAMPLE_INTERVAL_MS);
    lastSample = now;
    setEventLoopLagSeconds(eventLoopLagMs / 1000);
  }, SAMPLE_INTERVAL_MS);
  // Never keep the process alive just for the sampler.
  (lagTimer as { unref?: () => void }).unref?.();
}

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
  if (readiness.draining()) {
    return c.json({ status: 'draining', reason: 'shutdown in progress' }, 503);
  }
  if (!readiness.schemaReady()) {
    return c.json({ status: 'starting', reason: 'schema not ready' }, 503);
  }
  return c.json({ status: 'ok' });
};
app.get('/health/ready', readinessHandler);
app.get('/v1/health/ready', readinessHandler);

function hasInternalObservabilityAuth(c: any): boolean {
  const authHeader = c.req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
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

// RFC 9728 protected-resource metadata for a project's MCP endpoint — what an
// MCP client reads after the endpoint's 401 challenge to find the authorization
// server above.
app.get('/.well-known/oauth-protected-resource/v1/projects/:projectId/mcp', (c) => {
  const projectId = c.req.param('projectId');
  if (!isUuid(projectId)) return c.json({ error: 'Not found' }, 404);
  return c.json(mcpProtectedResourceMetadata(projectId, new URL(c.req.url).origin), 200, {
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

// Also expose system status at root for backward compat with frontend
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/system/status',
    tags: ['system'],
    summary: 'Maintenance / technical-issue banner status',
    responses: {
      200: json(
        z
          .object({
            maintenanceNotice: z.object({ enabled: z.boolean() }).passthrough(),
            technicalIssue: z.object({ enabled: z.boolean() }).passthrough(),
            updatedAt: z.string(),
          })
          .openapi('SystemStatus'),
        'System status',
      ),
    },
  }),
  (c: any) =>
    c.json({
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false },
      updatedAt: new Date().toISOString(),
    }),
);

// ─── Maintenance config (DB-backed; replaces Vercel Edge Config) ─────────────
// One row in kortix.platform_settings under 'maintenance_config'. GET is public
// (banner + maintenance page read it); PUT is admin-only. Set via /admin/utils.
const MAINTENANCE_KEY = 'maintenance_config';
const DEFAULT_MAINTENANCE = {
  level: 'none' as const,
  title: '',
  message: '',
  startTime: null,
  endTime: null,
  statusUrl: null,
  affectedServices: [] as string[],
  updatedAt: new Date(0).toISOString(),
};

const MaintenanceSchema = z
  .object({
    level: z.string(),
    title: z.string(),
    message: z.string(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    statusUrl: z.string().nullable(),
    affectedServices: z.array(z.string()),
    updatedAt: z.string(),
  })
  .partial()
  .openapi('MaintenanceConfig');

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/system/maintenance',
    tags: ['system'],
    summary: 'Read the maintenance config (public — banner + maintenance page)',
    responses: { 200: json(MaintenanceSchema, 'Maintenance config') },
  }),
  // Cacheable: the response never varies per tenant/user (no auth, same row
  // for every caller), so `public` is safe. `max-age=5` + ETag revalidation
  // shaves the repeat-poll DB roundtrip most callers pay without risking a
  // stale kill switch — this is the platform's emergency maintenance toggle,
  // so a long `stale-while-revalidate` (which would let a just-flipped-on
  // lockdown keep serving the OLD state to clients for minutes) is
  // deliberately not used here.
  async (c: any) => {
    if (!hasDatabase) {
      const etag = computeEtag(DEFAULT_MAINTENANCE);
      c.header('Cache-Control', 'public, max-age=5, must-revalidate');
      c.header('ETag', etag);
      if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
      return c.json(DEFAULT_MAINTENANCE);
    }
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, MAINTENANCE_KEY))
      .limit(1);
    const payload = row?.value ?? DEFAULT_MAINTENANCE;
    const etag = computeEtag(payload);
    c.header('Cache-Control', 'public, max-age=5, must-revalidate');
    c.header('ETag', etag);
    if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
    return c.json(payload);
  },
);

app.openapi(
  createRoute({
    method: 'put',
    path: '/v1/system/maintenance',
    tags: ['system'],
    summary: 'Update the maintenance config (admin only)',
    ...auth,
    middleware: [supabaseAuth] as const,
    request: {
      body: { content: { 'application/json': { schema: MaintenanceSchema } } },
    },
    responses: {
      200: json(MaintenanceSchema, 'Updated config'),
      ...errors(403, 503),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const role = await getPlatformRole(userId);
    if (role !== 'admin' && role !== 'super_admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    if (!hasDatabase) return c.json({ error: 'Database not configured' }, 503);
    const body = await readJsonObject(c);
    const maintenanceConfig = {
      ...DEFAULT_MAINTENANCE,
      ...body,
      updatedAt: new Date().toISOString(),
    };
    await db
      .insert(platformSettings)
      .values({
        key: MAINTENANCE_KEY,
        value: maintenanceConfig,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: maintenanceConfig, updatedAt: new Date() },
      });
    return c.json(maintenanceConfig);
  },
);

// ─── Demo request (public lead capture) ─────────────────────────────────────
// POST /v1/system/demo-request — public, unauthenticated. The marketing site's
// "Book a demo" qualifier form POSTs the first-step details here (via the web
// server); we email an internal notification to DEMO_LEAD_NOTIFY_EMAIL on every
// submission, whether or not the lead goes on to book a Cal slot. The email uses
// the API's email-provider credentials (AWS Secrets Manager), so the Vercel
// frontend never needs the secret. IP rate-limited; no configured email
// provider is a graceful skip, so lead capture never fails on account of email.
const DemoRequestSchema = z
  .object({
    name: z.string().max(200).optional(),
    email: z.string().email(),
    company_name: z.string().max(200).optional(),
    company_size: z.string().max(50).optional(),
    goal: z.string().max(2000).optional(),
    qualified: z.boolean().optional(),
    source: z.string().max(100).optional(),
  })
  .openapi('DemoRequest');

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/system/demo-request',
    tags: ['system'],
    summary: 'Submit a public demo request (emails an internal notification)',
    middleware: [createDemoRequestRateLimitMiddleware()] as const,
    request: {
      body: { content: { 'application/json': { schema: DemoRequestSchema } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), emailed: z.boolean() }).openapi('DemoRequestResult'),
        'Accepted',
      ),
      ...errors(400, 429),
    },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => null);
    const email = String(body?.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: 'Invalid email' }, 400);
    }
    const result = await sendDemoRequestNotification({
      name: typeof body.name === 'string' ? body.name : undefined,
      email,
      company_name: typeof body.company_name === 'string' ? body.company_name : undefined,
      company_size: typeof body.company_size === 'string' ? body.company_size : undefined,
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      qualified: typeof body.qualified === 'boolean' ? body.qualified : undefined,
      source: typeof body.source === 'string' ? body.source : undefined,
      user_agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
    });
    if (!result.ok && !('skipped' in result && result.skipped)) {
      console.error('[system/demo-request] notification not sent:', result);
    }
    return c.json({ ok: true, emailed: result.ok });
  },
);

// ─── Stub Endpoints ─────────────────────────────────────────────────────────
// These endpoints are called by the frontend but were never implemented.
// Adding proper stubs stops 404 noise and provides correct responses.

// POST /v1/prewarm — no-op pre-warm. Frontend fires this on login.
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/prewarm',
    tags: ['system'],
    summary: 'No-op pre-warm (frontend fires this on login)',
    responses: {
      200: json(z.object({ success: z.boolean() }).openapi('Prewarm'), 'ok'),
    },
  }),
  (c: any) => c.json({ success: true }),
);

}
