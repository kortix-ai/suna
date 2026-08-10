// Expand the aggregate ECS secret before any module reads process.env.
import './environment-secret';

// ─── Observability (must follow environment hydration) ───────────────────────
import './lib/sentry';
import { captureException, flushSentry, addBreadcrumb, isSentryIgnoredError } from './lib/sentry';
import { logger as appLogger, isLoggingTransportError } from './lib/logger';
import { emitOtelSpan } from './lib/otel';
import {
  recordHttpRequest,
  incInFlight,
  decInFlight,
  setEventLoopLagSeconds,
  renderMetrics,
  metricsEnabled,
} from './lib/metrics';
import {
  getDiagnosticFields,
  getRequestContext,
  runWithContext,
  setContextField,
} from './lib/request-context';
import { getRequestUrl, ensureAbsoluteRequestUrl } from './lib/request-url';

import { timingSafeEqual } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { mountOpenApiDocs, json, errors, auth } from './openapi';
import { createDemoRequestRateLimitMiddleware } from './shared/rate-limit';
import { sendDemoRequestNotification } from './lib/demo-request-email';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { HTTPException } from 'hono/http-exception';
import { config } from './config';
import { BillingError } from './errors';

// ─── Sub-Service Imports ────────────────────────────────────────────────────

import { router } from './router';
import { billingApp, accountDeletionApp } from './billing';
import { platformApp } from './platform';
import { sandboxProxyApp } from './sandbox-proxy';
import { setupApp } from './setup';
import { supabaseAuth, combinedAuth } from './middleware/auth';
import { createCorsMiddleware } from './middleware/cors';
import { requestDeadline, isRequestDeadlineHTTPException } from './middleware/request-deadline';
import { inspectDatabaseError } from './shared/database-errors';
import { isPlatinumSandboxNotRunningError } from './shared/platinum';
import {
  isDaytonaRateLimitError,
  primeDaytonaRateLimitClassifier,
} from './shared/daytona-rate-limit';
import {
  isDaytonaTransientProviderError,
  primeDaytonaTransientClassifier,
} from './shared/daytona-transient';
import { GitOperationError, isGitOperationError } from './projects/git/mirror';
// Statically imported (NOT await import() in the handlers): on a long-running
// `bun --hot` dev process, dynamic import() can wedge permanently after enough
// hot reloads — the promise never settles, the handler hangs, and Bun's
// idleTimeout kills the socket with an empty reply. Frontend-polled routes
// (maintenance banner, user-roles) must never sit behind a dynamic import.
import { db, hasDatabase } from './shared/db';
import { computeEtag, etagMatches } from './shared/http-cache';
import { getPlatformRole } from './shared/platform-roles';
import { platformSettings } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { ensureSchema } from './ensure-schema';
import { initModelPricing, stopModelPricing } from './router/config/model-pricing';
import { runtimeModelCatalog } from './llm-gateway/models/runtime-catalog';
import {
  tunnelApp,
  wsHandlers as tunnelWsHandlers,
  startTunnelService,
  stopTunnelService,
} from './tunnel';
import { voiceMcpRoutes } from './channels/voice/routes';
import { accessControlApp } from './access-control';
import { startAccessControlCache, stopAccessControlCache } from './shared/access-control-cache';
import { startTmpReaper, stopTmpReaper } from './snapshots/tmp-reaper';
import {
  isLeader,
  startLeaderElection,
  stopLeaderElection,
  runsSingletonWorkers,
} from './shared/leader-election';
import { marketplaceApp } from './marketplace';
import { skillsApp } from './skills';
import { runtimeAssetsApp } from './runtime-assets';
import { oauthApp } from './oauth';
import { nativeOAuth2CallbackApp } from './connectors/oauth2-callback';
import {
  projectWebhooksApp,
  projectsApp,
  startProjectTriggerScheduler,
  stopProjectTriggerScheduler,
  getTriggerSchedulerHealth,
} from './projects';
import { startProjectMaintenance, stopProjectMaintenance } from './projects/maintenance';
import { kickStartupPreBuild } from './snapshots/builder';
import { registerSunaMigrationRoutes } from './projects/suna-migration/suna-migration-routes';
import { handleAppPublicRequest, resolveAppRequest } from './apps/public-proxy';
import { appWsHandlers, prepareAppWsUpgrade } from './apps/ws-proxy';
import {
  startSunaMigrationWorker,
  stopSunaMigrationWorker,
} from './projects/suna-migration/suna-migration-worker';
import { startAppDeploymentWorker, stopAppDeploymentWorker } from './apps/deployment-worker';
import { startAppIdleReaper, stopAppIdleReaper } from './apps/idle-reaper';
import {
  startProviderTransitionWorker,
  stopProviderTransitionWorker,
} from './projects/provider-transition/provider-transition-worker';
import { accountsRouter } from './accounts';
import { authRouter } from './auth';
import { scimRouter } from './scim';
import { accountInvitesRouter } from './accounts/invites';
import { auditApiRequest } from './shared/audit';
import { startAuditWebhookWorker, stopAuditWebhookWorker } from './shared/audit-webhooks';
import {
  startAuditReconciliationWorker,
  stopAuditReconciliationWorker,
} from './shared/audit-reconciliation-worker';
import { opsApp } from './ops';
import { adminApp } from './admin';

// ─── Process-level crash guards ───────────────────────────────────────────────
// A stray rejected promise or throw escaping any fire-and-forget path — the
// dozens of `void (async …)()` provisioning/sweep ticks and the module-load
// `setInterval`s — must never take the whole multi-tenant server down. These run
// asynchronously, so they fire after these handlers are registered. We log +
// report and keep serving; orchestrator-level restart policy is deliberately
// left to the platform. Registering these handlers also overrides the runtime's
// default "crash on unhandled rejection" behavior, so this can only prevent
// crashes, never introduce one.
process.on('unhandledRejection', (reason: unknown) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // A logging-transport failure must NEVER be reported through the logging
    // transport (Better Stack) — that re-enqueues, re-overflows, and spirals,
    // which is exactly what took prod down on 2026-06-18. Record it locally and
    // drop it. See logger.ts isLoggingTransportError.
    if (isLoggingTransportError(`${err.message}\n${err.stack ?? ''}`)) {
      appLogger.localError('Dropped logging-transport rejection', {
        error: err.message,
      });
      return;
    }
    appLogger.error('Unhandled promise rejection', {
      error: err.message,
      stack: err.stack,
    });
    captureException(err, { handler: 'unhandledRejection' });
  } catch {
    // never let the crash guard itself crash the process
  }
});

process.on('uncaughtException', (err: Error) => {
  try {
    if (isLoggingTransportError(`${err?.message ?? ''}\n${err?.stack ?? ''}`)) {
      appLogger.localError('Dropped logging-transport exception', {
        error: err?.message ?? String(err),
      });
      return;
    }
    appLogger.error('Uncaught exception', {
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
    captureException(err, { handler: 'uncaughtException' });
  } catch {
    // never let the crash guard itself crash the process
  }
});

// ─── App Setup ──────────────────────────────────────────────────────────────

const app = new OpenAPIHono();
const UUID_PATH_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exported so tooling/tests can introspect the route table (app.routes) without
// booting the server. See the import.meta.main guard around startup below.
export { app };

app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/metrics' || path.startsWith('/health') || path.startsWith('/v1/health')) {
    return next();
  }
  const start = performance.now();
  incInFlight();
  let status = 0;
  try {
    await next();
    status = c.res.status;
  } catch (err) {
    // Record the thrown status (e.g. the request-deadline 503), not a blanket
    // 500 — otherwise deadline hits are unattributable per route in metrics.
    status = err instanceof HTTPException ? err.status : 500;
    throw err;
  } finally {
    decInFlight();
    recordHttpRequest({
      method: c.req.method,
      route: c.req.routePath || path,
      status: status || c.res.status,
      durationSeconds: (performance.now() - start) / 1000,
    });
  }
});

// === Global Middleware ===

const extraOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

app.use(
  '*',
  createCorsMiddleware({
    internalEnvironment: config.INTERNAL_KORTIX_ENV,
    extraOrigins,
  }),
);

// ─── Request context (AsyncLocalStorage) ────────────────────────────────────
// Must be FIRST — wraps the entire request lifecycle so all downstream code
// (auth, route handlers, console.error calls) automatically gets context fields
// (requestId, userId, accountId, sandboxId) attached to every log.
app.use('*', async (c, next) => {
  await runWithContext(
    c.req.method,
    c.req.path,
    async () => {
      // Auto-extract common resource IDs from URL patterns for logs/traces.
      const path = c.req.path;
      const projectSessionMatch = path.match(/\/projects\/([^/]+)\/sessions\/([^/]+)/);
      if (projectSessionMatch && UUID_PATH_SEGMENT_RE.test(projectSessionMatch[1])) {
        setContextField('projectId', projectSessionMatch[1]);
        setContextField('sessionId', projectSessionMatch[2]);
      } else {
        const projectMatch = path.match(/\/projects\/([^/]+)/);
        if (projectMatch && UUID_PATH_SEGMENT_RE.test(projectMatch[1])) {
          setContextField('projectId', projectMatch[1]);
        }
      }
      const sbMatch = path.match(/\/sandbox(?:es)?\/([^/]+)/) || path.match(/\/p\/([^/]+)/);
      if (sbMatch) setContextField('sandboxId', sbMatch[1]);
      await next();
      const ctx = getRequestContext();
      if (ctx) {
        c.header('X-Request-Id', ctx.requestId);
        c.header('traceparent', ctx.traceparent);
      }
    },
    c.req.header('traceparent'),
  );
});

// Request logger — uses Hono's built-in logger for stdout (Docker captures these)
app.use('*', logger());

// Post-request: Sentry breadcrumbs + slow/error request logging
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const path = c.req.path;
  const method = c.req.method;

  // Propagate userId/accountId to request context (set by auth middleware)
  const userId = (c as any).get('userId') as string | undefined;
  const accountId = (c as any).get('accountId') as string | undefined;
  if (userId) setContextField('userId', userId);
  if (accountId) setContextField('accountId', accountId);

  // Add breadcrumb to Sentry for request context on future errors
  addBreadcrumb(
    `${c.req.method} ${c.req.path} ${status}`,
    {
      method,
      path,
      status,
      duration,
      userAgent: c.req.header('user-agent')?.slice(0, 100),
    },
    'http',
  );

  // Expected sandbox proxy noise we intentionally suppress:
  // - long-poll/SSE event stream timing out after ~30s (504)
  // - sandbox startup probes returning 502/503 before services are ready
  const isSandboxProxyPath = path.includes('/v1/p/');
  const isProxyLongPoll =
    isSandboxProxyPath &&
    (path.includes('/global/event') ||
      path.includes('/session/status') ||
      /\/session\/[^/]+\/message(?:$|\?)/.test(path));
  const isProxyStartupProbe =
    isSandboxProxyPath &&
    (path.includes('/global/health') ||
      path.includes('/kortix/health') ||
      /\/sessions(?:\/|$)/.test(path));
  const isExpectedProxyNoise =
    method === 'GET' &&
    ((isProxyLongPoll &&
      ((status === 200 && duration > 5000) ||
        status === 504 ||
        status === 502 ||
        status === 503)) ||
      (isProxyStartupProbe && (status === 502 || status === 503 || status === 504)));

  // Health/liveness probes fire every few seconds from the ALB + kubelet across
  // every pod — by far the highest-volume request. A healthy probe carries no
  // signal, and shipping one log line per probe is what feeds the Better Stack
  // queue toward overflow. Suppress only SUCCESSFUL probes (a non-2xx still
  // logs, so a failing/degraded probe stays fully visible).
  const isHealthProbe =
    path === '/health' ||
    path === '/v1/health' ||
    path.endsWith('/health/live') ||
    path.endsWith('/health/ready');
  const suppressLog = isExpectedProxyNoise || (isHealthProbe && status < 400);

  if (!suppressLog) {
    const level = status >= 500 || duration > 5000 ? 'warn' : 'info';
    appLogger[level](`Request completed: ${method} ${path} ${status} ${duration}ms`, {
      status,
      duration,
      // Allowlisted, non-identifying only — see getDiagnosticFields. This is what
      // makes turn-stream `kind` queryable in CloudWatch Logs Insights; the full
      // request context (which carries identity) still goes to Better Stack only.
      ...getDiagnosticFields(),
    });
    void emitOtelSpan({
      name: `${method} ${path}`,
      kind: 'SERVER',
      startTimeMs: start,
      endTimeMs: Date.now(),
      attributes: {
        'http.method': method,
        'http.route': path,
        'http.status_code': status,
        'http.response.duration_ms': duration,
      },
    });
  }
});

// Pretty JSON in dev mode for easier debugging
if (config.INTERNAL_KORTIX_ENV === 'dev') {
  app.use('*', prettyJSON());
}

app.use('/v1/*', auditApiRequest);

// Wall-clock deadline for non-streaming requests — returns 503 before the 30s
// client abort instead of hanging. Streaming/proxy/WS surfaces are exempted
// inside the middleware; disable entirely with REQUEST_DEADLINE_MS=0.
app.use('/v1/*', requestDeadline);

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
    instance: API_INSTANCE,
    scheduler_leader: isLeader(),
    trigger_scheduler: getTriggerSchedulerHealth(),
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
    const body = await c.req.json().catch(() => ({}));
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

// /v1/accounts/* — account & member management lives in ./accounts router.
app.route('/v1/accounts', accountsRouter);
// /v1/auth/* — auth-side server endpoints (logout for now). Audit
// events for login/logout/failed-login live in the auth middleware
// + this router so SOC2 reviews see the full auth lifecycle.
app.route('/v1/auth', authRouter);
// SCIM 2.0 — separate auth (per-account bearer tokens, not Supabase JWT).
// Mounted outside /v1 so IdPs configure the documented protocol URL.
app.route('/scim/v2', scimRouter);

// /v1/account-invites/* — accept/decline/describe pending team invitations.
app.route('/v1/account-invites', accountInvitesRouter);

app.route('/v1/ops', opsApp);

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user-roles',
    tags: ['system'],
    summary: 'The caller’s platform role (admin gate)',
    ...auth,
    middleware: [supabaseAuth] as const,
    responses: {
      200: json(
        z.object({ isAdmin: z.boolean(), role: z.string().nullable() }).openapi('UserRoles'),
        'Platform role',
      ),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const accountId = c.get('userId') as string;
    const role = await getPlatformRole(accountId);
    const isAdmin = role === 'admin' || role === 'super_admin';

    return c.json({ isAdmin, role });
  },
);

// ─── Mount Sub-Services ─────────────────────────────────────────────────────
// All services follow the pattern: /v1/{serviceName}/...

app.route('/v1/router', router); // /v1/router/chat/completions, /v1/router/models, /v1/router/web-search, /v1/router/tavily/*, etc.

{
  // LLM gateway surfaces: in-API /v1/llm (full pipeline), /internal/gateway
  // control-plane RPC, and the /v1/llm-gateway reverse proxy. See ./llm-gateway/wire.
  const { mountLlmGateway } = await import('./llm-gateway/wire');
  mountLlmGateway(app);
}

// OpenRouter-parity read endpoints, scoped to the authenticated account.
import { generationApp } from './router/routes/generation';
import { usageApp } from './router/routes/usage';
app.route('/v1/generation', generationApp); // GET /v1/generation?id=<requestId> — single gateway-call forensics
app.route('/v1/usage', usageApp); // GET /v1/usage[?start&end&group_by] — account usage rollup

app.route('/v1/billing', billingApp); // /v1/billing/account-state, /v1/billing/webhooks/*
app.route('/v1/account', accountDeletionApp); // account deletion status/request/cancel/immediate
app.route('/v1/platform', platformApp); // /v1/platform, /v1/platform/sandbox/version
registerSunaMigrationRoutes(projectsApp); // /v1/projects/suna-migration/* (OG Suna → opencode, user-triggered)
// Voice routes are registered BEFORE projectsApp: Hono matches in registration
// order, and projectsApp's auth middleware would otherwise claim the worker's
// MCP callback (/sessions/:id/mcp/voice) and reject it with a generic 401
// before its own per-call HMAC check ever runs. The worker is not a Kortix
// session and cannot present session auth.
app.route('/v1/projects', voiceMcpRoutes);
app.route('/v1/projects', projectsApp); // /v1/projects — Git-backed Kortix projects
app.route('/v1/marketplace', marketplaceApp); // /v1/marketplace — browse the registry catalog

// /v1/skills — the kortix-managed system skills (how Kortix itself works), served
// straight out of @kortix/starter so the text always matches this deploy. This is
// what lets an agent in ANY harness, holding only the `kortix` binary and a token,
// read the platform's own instructions with no repo checkout and no sandbox.
// combinedAuth (not supabaseAuth) so a CLI `kortix_pat_` and the in-sandbox
// KORTIX_CLI_TOKEN works; see ./skills/index.ts for the full auth rationale.
app.use('/v1/skills', combinedAuth);
app.use('/v1/skills/*', combinedAuth);
app.route('/v1/skills', skillsApp); // GET /v1/skills, /v1/skills/:name[?full=1], /v1/skills/:name/file?path=

// /v1/runtime-assets — the sandbox runtime assets THIS deploy was built with:
// the `kortix` CLI binary it bakes into snapshots and the managed-skill overlay.
// A live sandbox reconciles against these on every session start/restart/resume,
// which is what stops an old box from running a CLI that predates the routes it
// calls. combinedAuth for the same reason as /v1/skills above: the callers are a
// `kortix_pat_` CLI and the in-sandbox KORTIX_CLI_TOKEN.
app.use('/v1/runtime-assets/*', combinedAuth);
app.route('/v1/runtime-assets', runtimeAssetsApp); // GET /manifest, /cli, /managed-skills

// Universal git smart-HTTP proxy — every git-backed project's client origin.
// Auth is handled inside (git sends Basic/Bearer, not combinedAuth's Bearer),
// so it is intentionally NOT wrapped in combinedAuth.
{
  const { gitProxyApp } = await import('./git-proxy');
  app.route('/v1/git', gitProxyApp); // /v1/git/:projectId(.git)/{info/refs,git-upload-pack,git-receive-pack}
}

// Connector — unified connector layer. Gateway routes (/catalog, /call) use
// KORTIX_CLI_TOKEN (validated inside the router); admin routes
// (/projects/:id/connectors*) need user auth, so combinedAuth runs first.
{
  const { connectorApp } = await import('./connectors');
  app.use('/v1/connectors/projects/*', combinedAuth);
  app.use('/v1/connectors/connect-status', combinedAuth); // deployment capability flag (authed)
  app.route('/v1/connectors', connectorApp);
}

app.route('/v1/webhooks', projectWebhooksApp); // /v1/webhooks/:triggerId — signed project trigger fires

const {
  slackWebhookApp,
  teamsWebhookApp,
  teamsIdentityApp,
  teamsOauthApp,
  telegramWebhookApp,
  slackOauthApp,
  slackIdentityApp,
  emailWebhookApp,
} = await import('./channels');
app.route('/v1/webhooks/slack/oauth', slackOauthApp); // /v1/webhooks/slack/oauth/callback — OAuth dance
app.route('/v1/webhooks/slack', slackWebhookApp); // /v1/webhooks/slack/:projectId — raw Slack events (BYO mode)
app.route('/v1/webhooks/teams/oauth', teamsOauthApp); // /v1/webhooks/teams/oauth/callback — admin-consent + catalog publish
app.route('/v1/webhooks/teams', teamsWebhookApp); // /v1/webhooks/teams/messages — Bot Framework activities
app.route('/v1/channels/slack/identity', slackIdentityApp); // /v1/channels/slack/identity/bind — authed /login bind
app.route('/v1/channels/teams/identity', teamsIdentityApp); // /v1/channels/teams/identity/bind — authed login bind
app.route('/v1/webhooks/telegram', telegramWebhookApp); // /v1/webhooks/telegram/:projectId — Telegram updates
app.route('/v1/webhooks/email', emailWebhookApp); // /v1/webhooks/email/agentmail — AgentMail inbound email (Svix-signed)

const { sandboxWebhooksApp } = await import('./platform/webhooks/routes');
app.route('/v1/webhooks/sandbox', sandboxWebhooksApp); // /v1/webhooks/sandbox/{daytona,platinum} — provider lifecycle → close billing

// Access control — public endpoints for signup gating
app.route('/v1/access', accessControlApp); // /v1/access/signup-status, /v1/access/check-email, /v1/access/request-access

// Setup links — PUBLIC, token-gated. An agent-minted (encrypted, short-lived,
// value-only) token is the bearer capability, so a human can fill in a secret
// or 1-click a Pipedream connect from a Slack link with no login. The mint half
// is authenticated, on projectsApp (/v1/projects/:id/{secret,connect}-requests).
import { setupLinksPublicApp } from './setup-links/public-app';
app.route('/v1/setup-links', setupLinksPublicApp); // /v1/setup-links/{secret,connector}/:token

// Approval links — AUTHENTICATED, unlike the setup links above. The token names
// which pending decision is being asked for; it never confers the right to make
// it (see setup-links/approval-app.ts for why an approval must not be a bearer
// capability). supabaseAuth 401s an anonymous hit so the page can bounce the
// human through login and return them here.
import { approvalLinksApp } from './setup-links/approval-app';
app.use('/v1/approval-links/*', supabaseAuth);
app.route('/v1/approval-links', approvalLinksApp); // GET /v1/approval-links/:token

// Public session shares — PUBLIC, share-id-gated. Anonymous, read-only
// session title + sanitized transcript for a valid session public-share
// (any resource type SESS-13's CRUD creates); backs the logged-out
// `/share/[shareId]` viewer (apps/web). No auth, no client-side sandbox
// access — the API reads the sandbox's OpenCode daemon server-side.
import { publicSessionSharesApp } from './public-session-shares';
app.route('/v1/public/session-shares', publicSessionSharesApp); // /v1/public/session-shares/:shareId[/messages]

// Anonymous resolve step for a `voice_spawn` join link: exchanges the short,
// ungessable id for a freshly-minted LiveKit access token + server URL. Backs
// the logged-out `/voice/[token]` page the same way publicSessionSharesApp
// backs `/share/[shareId]` above — see join-links.ts / public-join-routes.ts.
import { voiceJoinPublicApp } from './channels/voice/public-join-routes';
app.route('/v1/public/voice-join', voiceJoinPublicApp); // /v1/public/voice-join/:token

// Setup — local/self-hosted only. Hidden when billing is enabled so the admin
// surface isn't exposed on managed/cloud deployments.
if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
  app.route('/v1/setup', setupApp); // /v1/setup/install-status (public), rest (auth inside router)
}
// /v1/admin/* — admin console (accounts/users/ledger/credits). supabaseAuth +
// requireAdmin enforced inside the router. Backs apps/web/src/app/admin/.
app.route('/v1/admin', adminApp);

// OAuth2 provider — public token endpoint, auth on authorize/consent
app.route('/v1/oauth', oauthApp);
app.route('/v1/connectors/oauth2', nativeOAuth2CallbackApp);

// Public device-auth endpoints (no auth — CLI uses these)
import { createDeviceAuthPublicRouter } from './tunnel/routes/device-auth';
import { warmPipedreamCatalog } from './connectors/pipedream';
app.route('/v1/tunnel/device-auth', createDeviceAuthPublicRouter());

app.use('/v1/tunnel/*', async (c, next) => {
  // Skip auth for public device-auth routes: POST /device-auth and GET /device-auth/:code/status
  const path = c.req.path.replace('/v1/tunnel/device-auth', '');
  if (c.req.path.startsWith('/v1/tunnel/device-auth')) {
    if (c.req.method === 'POST' && (path === '' || path === '/')) return next();
    if (c.req.method === 'GET' && path.endsWith('/status')) return next();
  }
  return combinedAuth(c, next);
});
app.route('/v1/tunnel', tunnelApp);

// Preview Proxy — unified route for sandbox HTTP access.
// Pattern: /v1/p/{sandboxId}/{port}/* — sandboxId is the provider external ID,
// resolved to a reachable upstream URL via the provider ingress contract.
// Auth: unified previewProxyAuth (accepts Supabase JWT and kortix_ tokens).
// MUST be after all explicit routes (wildcard catch-all).
app.route('/v1/p', sandboxProxyApp);

// === Error Handling ===

app.onError((err, c) => {
  const method = c.req.method;
  const path = c.req.path;
  const errName = err.constructor?.name || 'Error';

  // Suppress SSE/long-poll abort noise — these are expected timeouts on sandbox proxy,
  // not real errors. The client reconnects automatically.
  const isAbort = errName === 'DOMException' || err.message?.includes('The operation was aborted');
  const isSandboxProxy = path.includes('/p/') && path.includes('/global/event');
  if (isAbort && isSandboxProxy) {
    return c.json({ error: true, message: 'Request timeout', status: 504 }, 504);
  }

  // Platinum auto-stops idle microVMs natively; while a box is stopped, POST
  // /:id/expose answers `409 sandbox_not_running`. That is an EXPECTED,
  // transient state, not a 500 — the caller either wakes the box and retries
  // (preview proxy) or the client retries (transcript / lease-discover). It
  // must NOT page Sentry, so the typed error is classified out of
  // captureException and surfaced as a retryable 503 + Retry-After (mirroring
  // the request-deadline 503 pattern). Other Platinum failures still throw a
  // generic Error and fall through to the generic capture below. See
  // shared/platinum.ts PlatinumSandboxNotRunningError.
  if (isPlatinumSandboxNotRunningError(err)) {
    appLogger.warn(`${method} ${path} -> 503 [PlatinumSandboxNotRunningError] ${err.message}`, {
      method,
      path,
      errorType: 'PlatinumSandboxNotRunningError',
    });
    c.header('Retry-After', '10');
    return c.json({ error: true, message: 'sandbox is not running', status: 503 }, 503);
  }

  // Daytona's org-wide throttler surfaces any HTTP 429 from the Daytona API as
  // `DaytonaRateLimitError: ThrottlerException: Too Many Requests`. That is an
  // EXPECTED, transient provider state — every Daytona call site (preview link
  // resolution, transcript / public-share reads, lease discover, reaper health,
  // env-sync fan-out, snapshot reconciliation, …) must NOT page Sentry for it.
  // Prior PRs (#3567, #4605) guarded call sites one-by-one but new paths kept
  // reintroducing the same Better Stack fingerprint (`ec26b248…`) because a
  // forgotten try/catch still let the 429 propagate here → captureException →
  // Sentry. This single classifier covers EVERY remaining + future call site:
  // it downgrades the expected Daytona 429 to a retryable 503 + Retry-After
  // WITHOUT paging Sentry (mirroring the Platinum / git-timeout / request-
  // deadline patterns). Other Daytona failures (404 missing box, 409 conflict,
  // 5xx outage, timeout, disk quota) still throw a generic error and fall
  // through to the generic capture below, so unexpected failures stay loud.
  // See shared/daytona-rate-limit.ts.
  if (isDaytonaRateLimitError(err)) {
    appLogger.warn(`${method} ${path} -> 503 [DaytonaRateLimitError] ${err.message}`, {
      method,
      path,
      errorType: 'DaytonaRateLimitError',
      errorName: err.name,
    });
    c.header('Retry-After', '10');
    return c.json(
      {
        error: true,
        message: 'sandbox provider is temporarily rate-limited',
        status: 503,
      },
      503,
    );
  }

  // A bare-clone / fetch of a project's git mirror that exceeds its timeout
  // (SIGTERM mid-transfer, large repo, transient network) is EXPECTED and
  // retryable — the mirror already retries once internally before surfacing.
  // Previously these surfaced as the opaque Better Stack pattern `8d0cffbb…`
  // ("Cloning into bare repository '/tmp/kortix/git-cache/….git'…" — git's
  // progress line captured on stderr before the kill, masking the real cause).
  // `runGit` now throws a typed `GitOperationError` (kind 'timeout') whose
  // message names the timeout; classify the transient kind into a retryable
  // 503 + Retry-After WITHOUT paging Sentry (mirroring Platinum /
  // request-deadline), while a real `failed` kind (auth / missing repo) still
  // falls through to Sentry with a meaningful `fatal:` message. See
  // projects/git/mirror.ts.
  if (isGitOperationError(err) && err.kind === 'timeout') {
    appLogger.warn(`${method} ${path} -> 503 [GitOperationError:timeout] ${err.message}`, {
      method,
      path,
      errorType: 'GitOperationError',
      gitKind: 'timeout',
      gitArgs: err.gitArgs,
      signal: err.signal,
    });
    c.header('Retry-After', '10');
    return c.json(
      {
        error: true,
        message: 'git mirror is temporarily unavailable',
        status: 503,
      },
      503,
    );
  }

  // A transient Daytona provider gateway / connection / timeout failure is
  // EXPECTED — the upstream Daytona API (or its nginx / Cloudflare-style
  // gateway) momentarily 502/503/504-ing, a socket reset mid-call, or the
  // SDK's own bounded call timing out. The SDK surfaces these as a generic
  // `DaytonaError` whose `message` is the raw upstream response body — when
  // the gateway 502s with an HTML error page, that HTML becomes the error
  // message verbatim, which is exactly what produced the recurring Better
  // Stack pattern `e98d61f1…` (`DaytonaError` with message
  // `<html>…<h1>502 Bad Gateway</h1>…</html>`, thrown from the SDK's axios
  // response interceptor at `createDaytonaError`). The 429 throttler case
  // is owned by `shared/daytona-rate-limit.ts` (`isDaytonaRateLimitError`)
  // and is NOT matched here — this classifier is the sibling for transient
  // gateway / connection / timeout failures. It downgrades those to a
  // retryable 503 + Retry-After WITHOUT paging Sentry (mirroring the
  // Platinum / git-timeout / request-deadline patterns), so a forgotten
  // try/catch at any Daytona call site (preview-link resolution, lease
  // discover, reaper health, env-sync fan-out, snapshot reconciliation, …)
  // can no longer page Better Stack for an upstream blip. Other Daytona
  // failures (404 missing box, 409 conflict, 401/403 auth, 400 validation,
  // disk quota, unexpected 5xx with a JSON body) still throw a generic
  // error and fall through to the generic capture below, so unexpected
  // failures stay loud. See shared/daytona-transient.ts.
  if (isDaytonaTransientProviderError(err)) {
    appLogger.warn(
      `${method} ${path} -> 503 [DaytonaError:transient] ${err.message.slice(0, 200)}`,
      {
        method,
        path,
        errorType: 'DaytonaError',
        errorName: err.name,
        statusCode: (err as { statusCode?: unknown }).statusCode ?? null,
      },
    );
    c.header('Retry-After', '10');
    return c.json(
      {
        error: true,
        message: 'sandbox provider is temporarily unavailable',
        status: 503,
      },
      503,
    );
  }

  if (err instanceof BillingError) {
    appLogger.error(`${method} ${path} -> ${err.statusCode} [BillingError]`, {
      statusCode: err.statusCode,
      message: err.message,
      path,
      method,
    });
    return c.json({ error: err.message }, err.statusCode as any);
  }

  if (err instanceof HTTPException) {
    // Only capture 5xx HTTP exceptions to Sentry (4xx are expected). The
    // request-deadline 503 is an EXPECTED, typed, retryable degradation (the
    // deadline net bounding a slow request) — already logged + metriced
    // per-route and returned with Retry-After. Capturing it to Sentry produced
    // the recurring Better Stack pattern `29af03…` "Request exceeded the 25s
    // server processing deadline" (the system working as designed), so classify
    // it out. See middleware/request-deadline.ts.
    if (err.status >= 500 && !isRequestDeadlineHTTPException(err)) {
      captureException(err, { method, path, status: err.status });
    }
    appLogger.error(`${method} ${path} -> ${err.status} [HTTPException]`, {
      status: err.status,
      message: err.message,
      path,
      method,
    });

    const response: Record<string, unknown> = {
      error: true,
      message: err.message,
      status: err.status,
    };

    if (isRequestDeadlineHTTPException(err)) {
      response.code = err.code;
    }

    // Add Retry-After header for 503s (sandbox waking up)
    if (err.status === 503) {
      c.header('Retry-After', '10');
    }

    return c.json(response, err.status);
  }

  // Database / postgres.js errors — extract the useful info, not the full SQL dump
  const databaseError = inspectDatabaseError(err);
  if (databaseError) {
    // Pool-exhaustion (Supabase pooler / PgBouncer session-mode saturation on
    // the us-east-2 shadow deployment) is a TRANSIENT infra/pooler-capacity
    // class, NOT a code bug — `(EMAXCONNSESSION) max clients reached in
    // session mode - max_size: 20` fires when the `FreeTierRotation`/
    // `YearlyRotation` cron ticks + `llm-gateway` catalog loads + a user
    // `GET /v1/projects` contend for the pooler's 20-session pool. It
    // resolves when load drops. Reusing `isSentryIgnoredError` keeps the
    // classification in one place (mirrors the #4709 ignore list + the
    // #5167/#5175 Daytona transient no-capture pattern). The DIRECT
    // `captureException` below would otherwise page Sentry despite
    // `ignoreErrors` (a direct call bypasses that list); skip it but STILL
    // log + STILL 500 so the client sees the error and retries. The infra
    // follow-up (raise the shadow pooler's `pool_size` / move to transaction
    // mode) is a human-owned external action recorded in the sweep ledger.
    // Better Stack patterns 721b7efe… (API) + b38179c5… (frontend symptom).
    const databaseMessage = databaseError.causeMessage ?? databaseError.outerMessage;
    const isPoolExhaustion = isSentryIgnoredError(
      databaseError.causeName ?? databaseError.outerName,
      databaseMessage,
    );
    if (!isPoolExhaustion) {
      captureException(err, {
        method,
        path,
        errorType: 'database',
        pgCode: databaseError.pgCode,
        table: databaseError.table,
        schema: databaseError.schema,
      });
    }
    appLogger.error(
      `${method} ${path} -> 500 [DB ${databaseError.severity || 'ERROR'} ${databaseError.pgCode || '?'}]`,
      {
        method,
        path,
        errorType: isPoolExhaustion ? 'database-pool-exhaustion' : 'database',
        transient: isPoolExhaustion || undefined,
        outerErrorType: databaseError.outerName,
        causeErrorType: databaseError.causeName,
        pgCode: databaseError.pgCode,
        severity: databaseError.severity,
        table: databaseError.table,
        schema: databaseError.schema,
        hint: databaseError.hint,
        detail: databaseError.detail,
        message: databaseError.outerMessage.split('\n')[0],
        causeMessage: databaseError.causeMessage?.split('\n')[0] ?? null,
      },
    );
  } else {
    // Generic unhandled error — capture to Sentry + structured log
    captureException(err, { method, path, errorType: errName });
    appLogger.error(`${method} ${path} -> 500 [${errName}] ${err.message}`, {
      method,
      path,
      errorType: errName,
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
    });
  }

  return c.json(
    {
      error: true,
      message: 'Internal server error',
      status: 500,
    },
    500,
  );
});

// === 404 Handler ===

app.notFound((c) => {
  return c.json(
    {
      error: true,
      message: 'Not found',
      status: 404,
    },
    404,
  );
});

// === Start Server ===

// Pre-load the Daytona SDK's `DaytonaRateLimitError` class so the synchronous
// `isDaytonaRateLimitError` classifier (on the global `app.onError` hot path)
// has its strongest instanceof signal available the first time a 429 throws —
// see shared/daytona-rate-limit.ts. Fire-and-forget: the classifier's
// name/statusCode/message fallbacks already cover the rare race where a 429
// throws before this resolves, so we never block startup on it.
void primeDaytonaRateLimitClassifier();

// Pre-load the Daytona SDK's `DaytonaTimeoutError` / `DaytonaConnectionError`
// classes so the synchronous `isDaytonaTransientProviderError` classifier (on
// the global `app.onError` hot path) has its strongest instanceof signal
// available the first time a transient gateway / connection / timeout failure
// throws — see shared/daytona-transient.ts. Fire-and-forget: the classifier's
// name / statusCode / message fallbacks already cover the rare race where a
// transient failure throws before this resolves, so we never block startup on
// it.
void primeDaytonaTransientClassifier();

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Kortix API Starting                      ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${config.PORT.toString().padEnd(49)}║
║  Env:  ${config.INTERNAL_KORTIX_ENV.padEnd(49)}║
╠═══════════════════════════════════════════════════════════╣
║  Services:                                                ║
║    /v1/router     (search, LLM, proxy)                    ║
║    /v1/billing    (subscriptions, credits, webhooks)       ║
║    /v1/platform   (api keys, sandbox version)               ║
║    /v1/projects   (Git-backed projects)                    ║
║    /v1/setup      (setup & env management)                 ║
║    /v1/tunnel     (reverse-tunnel to local machines)         ║
║    /v1/p         (sandbox proxy — local + cloud)            ║
╠═══════════════════════════════════════════════════════════╣
║  Database:   ${config.DATABASE_URL ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
║  Supabase:   ${config.SUPABASE_URL ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
║  Stripe:     ${config.STRIPE_SECRET_KEY ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
║  Billing:    ${(config.KORTIX_BILLING_INTERNAL_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(42)}║
║  Tunnel:     ${(config.TUNNEL_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(42)}║
║  Providers:  ${config.ALLOWED_SANDBOX_PROVIDERS.join(', ').padEnd(42)}║
╚═══════════════════════════════════════════════════════════╝
`);

// Local REST tests use the bundled model catalog and never contact models.dev.
if (process.env.KORTIX_MODEL_PRICING_LIVE_ENABLED !== '0') {
  await initModelPricing().catch((err) =>
    console.error('[startup] Model pricing init failed (will retry in 24h):', err),
  );
}
if (process.env.KORTIX_MODEL_CATALOG_LIVE_ENABLED !== '0') {
  runtimeModelCatalog
    .start()
    .catch((err) =>
      console.error('[startup] Gateway model catalog init failed (keeping bundled snapshot):', err),
    );
}

// Schema readiness gate — blocks DB-dependent requests until push completes.
let schemaReady = false;
// Drain flag — set on SIGTERM/SIGINT so the load balancer health check
// stops routing traffic before the process exits. The ECS deregistration
// delay (30s) gives the ALB time to notice the 503s and drain in-flight
// requests.
let draining = false;

// Ensure DB schema exists before starting services that depend on it.
// This is idempotent — safe to run on every startup.
// Services that run on EVERY replica. The access-control cache and tunnel
// service serve request-path needs (per-node caches + the WS acceptor), so they
// must be live on each node behind the load balancer.
async function startReplicaServices() {
  startAccessControlCache();
  startTunnelService();
  // Warm the runtime-settings cache BEFORE serving traffic so the admin-panel
  // toggles (warm_snapshot / provider_fallback) are honored from
  // request #1. Without this a fresh pod serves the cold-cache defaults for the
  // first ~30s — which on a deploy let warm_snapshot resolve to the (old hardcoded)
  // ON despite the admin "off", warm-forking a stale seed: the 2026-06-26 opencode
  // wedge. Best-effort: a DB hiccup leaves the fail-safe OFF defaults.
  await import('./platform/services/runtime-settings')
    .then((m) => m.refreshRuntimeSettings())
    .catch(() => {});
  // Warm the managed-GitHub-App config cache too — so a self-host instance
  // whose operator just ran the in-app GitHub App setup flow (rather than
  // `.env`) gets its DB-stored creds from request #1, not after a 30s TTL.
  await import('./platform/services/managed-github-app')
    .then((m) => m.refreshManagedGithubAppConfig())
    .catch(() => {});
  // Every replica stages snapshot/session-boot build contexts in tmpdir and can
  // leak them on error paths; sweep stale ones so they don't fill node disk and
  // trip DiskPressure evictions. Runs on all replicas (not leader-gated).
  startTmpReaper();
}

// Singleton background WORKERS — must run on EXACTLY ONE replica at a time
// (the elected leader). On ECS Fargate the API runs as N replicas (prod: min 2,
// up to 10); running these on every replica would double-fire cron triggers
// (N duplicate paid agent sessions + duplicate external side effects) and
// double-run legacy migrations. Leader
// election (shared/leader-election.ts) starts/stops these via onAcquire/onRelease.
// The guard makes start/stop idempotent across leadership flaps.
let singletonWorkersRunning = false;
async function startSingletonWorkers() {
  if (singletonWorkersRunning) return;
  singletonWorkersRunning = true;
  startProjectMaintenance();
  startProjectTriggerScheduler();
  // Mint the global platform-default sandbox image once per leadership term so
  // the first session anywhere lands on a cache hit. Idempotent + best-effort;
  // the session-boot graceful path is the lazy fallback if this is skipped.
  kickStartupPreBuild();
  startSunaMigrationWorker();
  // Resume durable sandbox-provider migrations (prepare→verify→activate) that
  // were mid-flight when the API last stopped — a crash at building/ready/
  // activating converges instead of stranding. Safe across replicas (lease CAS).
  startProviderTransitionWorker();
  startAppDeploymentWorker();
  startAppIdleReaper();
  startAuditWebhookWorker();
  startAuditReconciliationWorker();
  // IAM V2 time-bounded grants: tick every 60s, emit one audit event per row
  // that just transitioned to expired. Engine already filters expired rows out
  // of authorize() so correctness doesn't depend on this — it's the audit trail.
  const { startGrantExpirySweeper } = await import('./iam/expiry-sweeper');
  startGrantExpirySweeper();
}
async function stopSingletonWorkers() {
  if (!singletonWorkersRunning) return;
  singletonWorkersRunning = false;
  stopProjectTriggerScheduler();
  stopProjectMaintenance();
  stopSunaMigrationWorker();
  stopProviderTransitionWorker();
  stopAppDeploymentWorker();
  stopAppIdleReaper();
  await stopAuditWebhookWorker();
  await stopAuditReconciliationWorker();
  const { stopGrantExpirySweeper } = await import('./iam/expiry-sweeper');
  stopGrantExpirySweeper();
}

// Boot the per-node services, then begin leader election. The leader runs the
// singleton workers; every other replica just serves requests. Works with one
// replica (sole leader) or many (exactly one leader), and with no DATABASE_URL
// (self-host single node → sole leader, no coordination).
async function bootServices() {
  await startReplicaServices();
  // Only pods that actually run singleton workers join the election. An API-only
  // pod (workers disabled) that won the lease would become a dead-weight leader,
  // holding it while running nothing and starving the scheduler fleet-wide.
  const eligible = runsSingletonWorkers();
  if (!eligible) {
    appLogger.info(
      '[workers] API-only pod — singleton workers disabled; not joining leader election',
    );
  }
  startLeaderElection(
    {
      onAcquire: () => startSingletonWorkers(),
      onRelease: () => stopSingletonWorkers(),
    },
    { eligible },
  );
  // Build the Pipedream catalogue index in the background. Deliberately NOT
  // awaited: the crawl is ~33 requests / ~48s, and readiness must not wait on
  // a third party. Until it lands, the catalogue routes answer from the live
  // paged API (`indexReady: false`), so a cold pod serves correct results the
  // whole time — just without category facets.
  warmPipedreamCatalog();
}

// Graceful shutdown
async function shutdown(signal: string) {
  // Set draining flag FIRST so the ALB health check starts returning 503
  // and the load balancer stops routing new requests to this instance.
  // The deregistration_delay (30s) gives in-flight requests time to complete.
  draining = true;
  appLogger.info(`Shutting down gracefully`, { signal });
  // Releases the lease (so a peer takes over immediately instead of waiting out
  // the TTL) and stops the singleton workers via onRelease — but only if this
  // node was the leader. Then stop the per-node services.
  await stopLeaderElection();
  stopModelPricing();
  runtimeModelCatalog.stop();
  stopTunnelService();
  stopAccessControlCache();
  stopTmpReaper();
  // Flush observability data before exit
  await Promise.allSettled([appLogger.flush(), flushSentry()]);
  process.exit(0);
}

// Boot only when this module is the entry point (`bun run src/index.ts`, which
// is how both `pnpm dev` and the Docker CMD launch it). Guarding behind
// import.meta.main lets tooling and tests `import { app }` to introspect the
// route table without starting the DB schema check, background workers, or
// signal handlers. Does NOT change production boot — there, import.meta.main is true.
if (import.meta.main) {
  ensureSchema()
    .then(async () => {
      schemaReady = true;
      // V2 IAM hard-codes role permissions in iam/role-perms.ts, so the
      // boot-time system-role seed + membership-policy backfill from V1
      // are no longer needed. Permissions resolve directly from
      // account_members.account_role and project_members.project_role.
      await bootServices();
    })
    .catch(async (err) => {
      console.error('[startup] ensureSchema failed, starting services anyway:', err);
      schemaReady = true;
      await bootServices();
    });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Subdomain preview routing — `p{port}-{sandboxId}.localhost:{apiPort}/...`
// Handled at the Bun.serve level so the proxied app sees itself at root `/`
// (Hono can't match on the Host header). See `sandbox-proxy/subdomain.ts`.
import { handleSubdomainRequest, parsePreviewSubdomain } from './sandbox-proxy/subdomain';
import {
  matchPreviewWsPath,
  preparePreviewWsUpgrade,
  previewWsHandlers,
} from './sandbox-proxy/ws-proxy';

export default {
  port: config.PORT,

  // Bun's default HTTP idleTimeout is 10s: a handler that hasn't written any
  // bytes by then gets its socket closed with an EMPTY reply — no status, no
  // body — which clients report as a bare network error and Better Stack as a
  // URL-only timeout. Raise it above the 25s request deadline so a genuinely
  // stuck request surfaces as the middleware's clean 503 (with Retry-After)
  // instead of a socket kill. Long-poll/SSE surfaces opt out per-request via
  // server.timeout(req, 0) below.
  // Must stay comfortably ABOVE the 25s request deadline. When this equalled
  // the client's own 30s timeout, whichever fired first was a coin flip, and
  // the socket-kill path returns an empty reply that the load balancer turns
  // into a 502 with no CORS headers — surfacing in browsers as a bogus CORS
  // error rather than a timeout.
  idleTimeout: 45,

  async fetch(req: Request, server: any): Promise<Response | undefined> {
    // Bun.serve sets `req.url` to a PATH-ONLY string (`"/"`,
    // `"/nice%20ports%2C/Tri%6Eity.txt%2ebak"`, …) for requests that arrive
    // WITHOUT a `Host` header — raw HTTP/1.0 port-scanner probes and malformed
    // clients. Every downstream `new URL(c.req.url)` / `new URL(req.url)`
    // call site (auth middleware, OpenAPI server URL, sandbox preview /
    // public-share proxy, git proxy, Slack/Teams webhook routers, …) assumes
    // an absolute URL and would otherwise throw
    // `TypeError: "…" cannot be parsed as a URL.` → app.onError → Sentry.
    // Rebuild the Request once, here, with the absolute URL so all of those
    // call sites are safe. No-op for normal requests (which already carry an
    // absolute `req.url`). See lib/request-url.ts ensureAbsoluteRequestUrl.
    // BS pattern 28e9a65c… (scanner noise, 0 users, first seen 2026-04-27).
    req = ensureAbsoluteRequestUrl(req, config.PORT);
    const url = getRequestUrl(req, config.PORT);
    const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

    // Sandbox preview traffic includes OpenCode long-poll and SSE routes. Let
    // the proxy's own upstream timeout decide instead of Bun closing the client
    // socket early with an empty reply.
    if (url.pathname.includes('/v1/p/')) {
      server.timeout(req, 0);
    }

    // The standalone-gateway reverse proxy streams chat completions (SSE). Let
    // the gateway's own keep-alive / upstream timeout govern it instead of Bun
    // closing the client socket at idleTimeout with an empty reply.
    if (url.pathname.startsWith('/v1/llm-gateway')) {
      server.timeout(req, 0);
    }

    // ── Subdomain preview routing ──────────────────────────────────────
    // Matches `p{port}-{sandboxId}.localhost:{apiPort}` regardless of path.
    // Same per-request long-poll/SSE timeout posture as /v1/p/.
    const host = req.headers.get('host') || '';
    if (resolveAppRequest(req, url)) {
      server.timeout(req, 0);
      if (isWsUpgrade) {
        const prepared = await prepareAppWsUpgrade(req, url);
        if (!prepared.ok) {
          return new Response(JSON.stringify({ error: prepared.message }), {
            status: prepared.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const upgraded = server.upgrade(req, { data: prepared.data });
        if (upgraded) return undefined;
        return new Response(JSON.stringify({ error: 'App WebSocket upgrade failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const appResponse = await handleAppPublicRequest(req);
      if (appResponse) return appResponse;
    }
    if (parsePreviewSubdomain(host)) {
      server.timeout(req, 0);
      // WS-on-subdomain isn't wired yet (agent server's port-proxy is
      // HTTP-only). Reject the upgrade cleanly so the client falls back
      // gracefully instead of timing out.
      if (isWsUpgrade) {
        return new Response(
          JSON.stringify({
            error: 'WebSocket upgrade on preview subdomain not implemented',
          }),
          { status: 501, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const res = await handleSubdomainRequest(req, url);
      if (res) return res;
    }

    // ── Tunnel Agent WebSocket ──────────────────────────────────────────
    // Agent connects, then authenticates via first message (auth handshake).
    // Token is never sent in URL — only tunnelId is in the query string.
    if (isWsUpgrade && url.pathname === '/v1/tunnel/ws') {
      if (!schemaReady) {
        return new Response(JSON.stringify({ error: 'Service starting up, try again shortly' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
        });
      }

      const tunnelId = url.searchParams.get('tunnelId');

      if (
        !tunnelId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tunnelId)
      ) {
        return new Response(JSON.stringify({ error: 'A valid tunnelId is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Agent Tunnel is a native CLI protocol. Browsers always send Origin on
      // WebSocket upgrades; rejecting it prevents cross-site WebSocket use if
      // a machine bearer is ever exposed to browser-accessible state.
      if (req.headers.has('origin')) {
        return new Response(
          JSON.stringify({
            error: 'Browser tunnel WebSockets are not allowed',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // Include the source address so an unauthenticated attacker who learns a
      // tunnelId cannot consume the real machine's reconnect budget.
      const { tunnelRateLimiter } = await import('./tunnel/core/rate-limiter');
      const clientIp =
        req.headers.get('cf-connecting-ip')?.trim() ||
        req.headers.get('x-real-ip')?.trim() ||
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown';
      const wsIpRateCheck = tunnelRateLimiter.check('wsConnectIp', clientIp);
      if (!wsIpRateCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: 'Too many connection attempts',
            retryAfterMs: wsIpRateCheck.retryAfterMs,
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const wsRateCheck = tunnelRateLimiter.check('wsConnect', `${clientIp}:${tunnelId}`);
      if (!wsRateCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: 'Too many connection attempts',
            retryAfterMs: wsRateCheck.retryAfterMs,
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      const success = server.upgrade(req, {
        data: {
          type: 'tunnel-agent',
          tunnelId,
        },
      });
      if (success) return undefined;
    }

    // ── Preview WebSocket proxy ─────────────────────────────────────────
    // Path-based preview upgrades (`/v1/p/{sandboxId}/{port}/...`) — today the
    // xterm PTY terminal. Authenticate via the `?token=` query param (browsers
    // can't set WS headers), resolve the sandbox upstream, then upgrade and
    // pipe bytes. See sandbox-proxy/ws-proxy.ts.
    if (isWsUpgrade && matchPreviewWsPath(url.pathname)) {
      if (!schemaReady) {
        return new Response(JSON.stringify({ error: 'Service starting up, try again shortly' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
        });
      }
      const prep = await preparePreviewWsUpgrade(url);
      if (!prep.ok) {
        return new Response(JSON.stringify({ error: prep.message }), {
          status: prep.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const success = server.upgrade(req, { data: prep.data });
      if (success) return undefined;
      return new Response(JSON.stringify({ error: 'WebSocket upgrade failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return app.fetch(req, server);
  },

  websocket: {
    // Disable Bun's default 120s idle timeout — tunnel agents use their own
    // heartbeat mechanism (30s ping/pong) for liveness detection.
    idleTimeout: 0,

    open(ws: {
      data: any;
      send: (data: any) => void;
      close: (code?: number, reason?: string) => void;
    }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onOpen(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.open(ws as any);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.open(ws as any);
        return;
      }
      // No other WS upgrades are accepted.
      try {
        ws.close(1011, 'unsupported websocket upgrade');
      } catch {}
    },

    message(
      ws: { data: any; close: (code?: number, reason?: string) => void },
      message: string | Buffer,
    ) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onMessage(ws.data.tunnelId, ws as any, message);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.message(ws as any, message);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.message(ws as any, message);
        return;
      }
    },

    close(ws: { data: any }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onClose(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.close(ws as any);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.close(ws as any);
        return;
      }
    },
  },
};
