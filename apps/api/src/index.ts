// ─── Observability (must be first — instruments before other imports) ────────
import './lib/sentry';
import { captureException, flushSentry, addBreadcrumb } from './lib/sentry';
import { logger as appLogger } from './lib/logger';
import { emitOtelSpan } from './lib/otel';
import { getRequestContext, runWithContext, setContextField } from './lib/request-context';
import { getRequestUrl } from './lib/request-url';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { HTTPException } from 'hono/http-exception';
import { config, SANDBOX_VERSION } from './config';
import { BillingError } from './errors';

// ─── Sub-Service Imports ──────────────────────────────────────────────────── 

import { router } from './router';
import { billingApp, accountDeletionApp } from './billing';
import { platformApp } from './platform';
import { sandboxProxyApp } from './sandbox-proxy';
import { isKortixToken } from './shared/crypto';
import { getSupabase } from './shared/supabase';
import { verifySupabaseJwt } from './shared/jwt-verify';
import { canAccessPreviewSandbox } from './shared/preview-ownership';
import { setupApp } from './setup';
import { queueApp, startDrainer, stopDrainer } from './queue';
import { serversApp } from './servers';
// WoA is now mounted under the router at /v1/router/woa (see router/index.ts)
import { supabaseAuth, combinedAuth } from './middleware/auth';
import { validateSecretKey } from './repositories/api-keys';
import { ensureSchema } from './ensure-schema';
import { initModelPricing, stopModelPricing } from './router/config/model-pricing';
import { tunnelApp, wsHandlers as tunnelWsHandlers, startTunnelService, stopTunnelService, getTunnelServiceStatus } from './tunnel';
import { accessControlApp } from './access-control';
// import { cloudGatewayApp } from './cloud-gateway/routes'; // TODO: restore once cloud-gateway routes land
import { startAccessControlCache, stopAccessControlCache } from './shared/access-control-cache';
import { oauthApp } from './oauth';
import {
  projectWebhooksApp,
  projectsApp,
  startProjectTriggerScheduler,
  stopProjectTriggerScheduler,
} from './projects';
import { startProjectMaintenance, stopProjectMaintenance } from './projects/maintenance';
import { accountsRouter } from './accounts';
import { authRouter } from './auth';
import { scimRouter } from './scim';
import { accountInvitesRouter } from './accounts/invites';
import { auditStateChangingRequest } from './shared/audit';
import { opsApp } from './ops';

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
    appLogger.error('Unhandled promise rejection', { error: err.message, stack: err.stack });
    captureException(err, { handler: 'unhandledRejection' });
  } catch {
    // never let the crash guard itself crash the process
  }
});

process.on('uncaughtException', (err: Error) => {
  try {
    appLogger.error('Uncaught exception', { error: err?.message ?? String(err), stack: err?.stack });
    captureException(err, { handler: 'uncaughtException' });
  } catch {
    // never let the crash guard itself crash the process
  }
});

// ─── App Setup ──────────────────────────────────────────────────────────────

const app = new Hono();

// === Global Middleware === 

// CORS origins: production domains + localhost for local dev + any extras from env.
const cloudOrigins = [
  'https://www.kortix.com',
  'https://kortix.com',
  'https://dev.kortix.com',
  'https://new-dev.kortix.com',
  'https://dev-new.kortix.com',
  'https://staging.kortix.com',
  'https://kortix.cloud',
  'https://www.kortix.cloud',
  'https://new.kortix.com',
];
const localOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
const extraOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const corsOrigins = [
  ...new Set([
    ...cloudOrigins,
    ...localOrigins,  // Always include — needed for local dev and self-hosted
    ...extraOrigins,
  ]),
];

app.use(
  '*',
  cors({
    origin: corsOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Kortix-Token', 'X-Api-Key', 'Accept', 'X-Kortix-Signature', 'X-Hub-Signature-256', 'traceparent', 'tracestate', 'X-Request-Id'],
    credentials: true,
  })
);

// ─── Request context (AsyncLocalStorage) ────────────────────────────────────
// Must be FIRST — wraps the entire request lifecycle so all downstream code
// (auth, route handlers, console.error calls) automatically gets context fields
// (requestId, userId, accountId, sandboxId) attached to every log.
app.use('*', async (c, next) => {
  await runWithContext(c.req.method, c.req.path, async () => {
    // Auto-extract common resource IDs from URL patterns for logs/traces.
    const path = c.req.path;
    const projectSessionMatch = path.match(/\/projects\/([^/]+)\/sessions\/([^/]+)/);
    if (projectSessionMatch) {
      setContextField('projectId', projectSessionMatch[1]);
      setContextField('sessionId', projectSessionMatch[2]);
    } else {
      const projectMatch = path.match(/\/projects\/([^/]+)/);
      if (projectMatch) setContextField('projectId', projectMatch[1]);
    }
    const sbMatch = path.match(/\/sandbox(?:es)?\/([^/]+)/) ||
                    path.match(/\/p\/([^/]+)/);
    if (sbMatch) setContextField('sandboxId', sbMatch[1]);
    await next();
    const ctx = getRequestContext();
    if (ctx) {
      c.header('X-Request-Id', ctx.requestId);
      c.header('traceparent', ctx.traceparent);
    }
  }, c.req.header('traceparent'));
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
  addBreadcrumb(`${c.req.method} ${c.req.path} ${status}`, {
    method,
    path,
    status,
    duration,
    userAgent: c.req.header('user-agent')?.slice(0, 100),
  }, 'http');

  // Expected sandbox proxy noise we intentionally suppress:
  // - long-poll/SSE event stream timing out after ~30s (504)
  // - sandbox startup probes returning 502/503 before services are ready
  const isSandboxProxyPath = path.includes('/v1/p/');
  const isProxyLongPoll = isSandboxProxyPath && (
    path.includes('/global/event') ||
    path.includes('/session/status') ||
    /\/session\/[^/]+\/message(?:$|\?)/.test(path)
  );
  const isProxyStartupProbe = isSandboxProxyPath && (
    path.includes('/global/health') ||
    path.includes('/kortix/health') ||
    /\/sessions(?:\/|$)/.test(path)
  );
  const isExpectedProxyNoise = method === 'GET' && (
    (isProxyLongPoll && (
      (status === 200 && duration > 5000) ||
      status === 504 ||
      status === 502 ||
      status === 503
    )) ||
    (isProxyStartupProbe && (status === 502 || status === 503 || status === 504))
  );

  if (!isExpectedProxyNoise) {
    const level = status >= 500 || duration > 5000 ? 'warn' : 'info';
    appLogger[level](`Request completed: ${method} ${path} ${status} ${duration}ms`, {
      status,
      duration,
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

app.use('/v1/*', auditStateChangingRequest);

// === Top-Level Health Check (no auth) ===

// API version is injected at container start by deploy-zero-downtime.sh,
// which extracts it from the Docker image tag (e.g. kortix/kortix-api:0.8.29 → 0.8.29).
// Falls back to 'dev' for local development.
const API_VERSION = process.env.SANDBOX_VERSION || 'dev';

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'kortix-api',
    version: API_VERSION,
    timestamp: new Date().toISOString(),
    billing_enabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
    tunnel: getTunnelServiceStatus(),
  });
});

// Health check under /v1 prefix (frontend uses NEXT_PUBLIC_BACKEND_URL which includes /v1)
app.get('/v1/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'kortix-api',
    version: API_VERSION,
    timestamp: new Date().toISOString(),
    billing_enabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
    tunnel: getTunnelServiceStatus(),
  });
});

// Also expose system status at root for backward compat with frontend
app.get('/v1/system/status', (c) => {
  return c.json({
    maintenanceNotice: { enabled: false },
    technicalIssue: { enabled: false },
    updatedAt: new Date().toISOString(),
  });
});

// ─── Stub Endpoints ─────────────────────────────────────────────────────────
// These endpoints are called by the frontend but were never implemented.
// Adding proper stubs stops 404 noise and provides correct responses.

// POST /v1/prewarm — no-op pre-warm. Frontend fires this on login.
app.post('/v1/prewarm', (c) => {
  return c.json({ success: true });
});

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


app.get('/v1/user-roles', supabaseAuth, async (c: any) => {
  const { getPlatformRole } = await import('./shared/platform-roles');

  const accountId = c.get('userId') as string;
  const role = await getPlatformRole(accountId);
  const isAdmin = role === 'admin' || role === 'super_admin';

  return c.json({ isAdmin, role });
});

// ─── Mount Sub-Services ─────────────────────────────────────────────────────
// All services follow the pattern: /v1/{serviceName}/...

app.route('/v1/router', router);        // /v1/router/chat/completions, /v1/router/models, /v1/router/web-search, /v1/router/tavily/*, etc.

{
  const { createLlmGateway } = await import('./llm-gateway');
  const { attributeYoloToken } = await import('./billing/services/yolo-tokens');
  const { assertBillingActive } = await import('./billing/services/billing-gate');
  const { deductForLlmUsage } = await import('./billing/services/credits');
  const { recordUsageEvent } = await import('./shared/usage-events');
  const { llmPriceMarkup } = await import('./billing/services/tiers');

  app.route(
    '/v1/llm',
    createLlmGateway(
      {
        enabled: process.env.LLM_GATEWAY_ENABLED === 'true',
        openrouterApiKey: process.env.KORTIX_OPENROUTER_API_KEY ?? '',
        markup: llmPriceMarkup(),
        appName: 'Kortix',
        appReferer: process.env.KORTIX_URL,
      },
      {
        authenticateToken: (token) => attributeYoloToken(token),
        assertBillingActive,
        recordUsage: async (event) => {
          // Always record usage_events for observability (token counts, model,
          // request id) — useful in self-hosted for debugging even with no
          // wallet deduction.
          const usageEventId = await recordUsageEvent({
            accountId: event.accountId,
            actorUserId: event.actorUserId,
            provider: event.provider,
            model: event.model,
            route: '/v1/llm/chat/completions',
            inputTokens: event.promptTokens,
            outputTokens: event.completionTokens,
            cachedTokens: event.cachedTokens,
            costUsd: event.finalCost,
            streaming: event.streaming,
            metadata: {
              upstreamCostUsd: event.upstreamCost,
              markup: llmPriceMarkup(),
              requestId: event.requestId,
            },
          });
          // Hard gate: never debit the wallet when billing is disabled.
          if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;
          await deductForLlmUsage({
            accountId: event.accountId,
            costUsd: event.finalCost,
            model: event.model,
            provider: event.provider,
            actorUserId: event.actorUserId,
            usageEventId,
            upstreamCostUsd: event.upstreamCost,
            markup: llmPriceMarkup(),
          });
        },
      },
    ),
  );
}

app.route('/v1/billing', billingApp);   // /v1/billing/account-state, /v1/billing/webhooks/*, /v1/billing/setup/*
app.route('/v1/account', accountDeletionApp); // account deletion status/request/cancel/immediate
app.route('/v1/platform', platformApp); // /v1/platform, /v1/platform/sandbox/version
app.route('/v1/projects', projectsApp); // /v1/projects — Git-backed Kortix projects

// Executor — unified connector layer. Gateway routes (/connectors, /call) use
// KORTIX_EXECUTOR_TOKEN (validated inside the router); admin routes
// (/projects/:id/connectors*) need user auth, so combinedAuth runs first.
{
  const { executorApp } = await import('./executor');
  app.use('/v1/executor/projects/*', combinedAuth);
  app.route('/v1/executor', executorApp); // /v1/executor/connectors, /call, /projects/:id/connectors[/sync|/:slug/sharing]
}

app.route('/v1/webhooks', projectWebhooksApp); // /v1/webhooks/:triggerId — signed project trigger fires

const { slackWebhookApp, telegramWebhookApp, slackOauthApp } = await import('./channels');
app.route('/v1/webhooks/slack/oauth', slackOauthApp); // /v1/webhooks/slack/oauth/callback — OAuth dance
app.route('/v1/webhooks/slack', slackWebhookApp); // /v1/webhooks/slack/:projectId — raw Slack events (BYO mode)
app.route('/v1/webhooks/telegram', telegramWebhookApp); // /v1/webhooks/telegram/:projectId — Telegram updates

if (config.KORTIX_DEPLOYMENTS_ENABLED) {
  const { deploymentsApp } = await import('./deployments');
  app.route('/v1/deployments', deploymentsApp); // /v1/deployments/*
}

// Access control — public endpoints for signup gating
app.route('/v1/access', accessControlApp); // /v1/access/signup-status, /v1/access/check-email, /v1/access/request-access

// Setup — local/self-hosted only. Hidden when billing is enabled so the admin
// surface isn't exposed on managed/cloud deployments.
if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
  app.route('/v1/setup', setupApp);        // /v1/setup/install-status (public), rest (auth inside router)
}
// /v1/admin/* — legacy admin dashboard surface removed. Web admin pages will 404.

// OAuth2 provider — public token endpoint, auth on authorize/consent
app.route('/v1/oauth', oauthApp);

// All remaining routes require authentication (JWT or kortix_ token).
app.use('/v1/servers/*', combinedAuth);
app.route('/v1/servers', serversApp);        // /v1/servers, /v1/servers/:id, /v1/servers/sync

app.use('/v1/queue/*', combinedAuth);
app.route('/v1/queue', queueApp);            // /v1/queue/sessions/:id, /v1/queue/messages/:id, /v1/queue/all, /v1/queue/status

// Public device-auth endpoints (no auth — CLI uses these)
import { createDeviceAuthPublicRouter } from './tunnel/routes/device-auth';
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

// WoA moved to /v1/router/woa — see router/index.ts

// Preview Proxy — unified route for both cloud (Daytona) and local mode.
// Pattern: /v1/p/{sandboxId}/{port}/* for ALL modes.
// Cloud:  sandboxId = Daytona external ID → proxied via Daytona SDK
// Local:  sandboxId = container name (e.g. 'kortix-sandbox') → Docker DNS resolution
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

  if (err instanceof BillingError) {
    appLogger.error(`${method} ${path} -> ${err.statusCode} [BillingError]`, {
      statusCode: err.statusCode, message: err.message, path, method,
    });
    return c.json({ error: err.message }, err.statusCode as any);
  }

  if (err instanceof HTTPException) {
    // Only capture 5xx HTTP exceptions to Sentry (4xx are expected)
    if (err.status >= 500) {
      captureException(err, { method, path, status: err.status });
    }
    appLogger.error(`${method} ${path} -> ${err.status} [HTTPException]`, {
      status: err.status, message: err.message, path, method,
    });

    const response: Record<string, unknown> = {
      error: true,
      message: err.message,
      status: err.status,
    };

    // Add Retry-After header for 503s (sandbox waking up)
    if (err.status === 503) {
      c.header('Retry-After', '10');
    }

    return c.json(response, err.status);
  }

  // Database / postgres.js errors — extract the useful info, not the full SQL dump
  const isDbError = errName === 'PostgresError' || (err as any).severity || (err as any).code?.match?.(/^[0-9]{5}$/);
  if (isDbError) {
    const pgErr = err as any;
    captureException(err, {
      method, path, errorType: 'database',
      pgCode: pgErr.code, table: pgErr.table, schema: pgErr.schema_name || pgErr.schema,
    });
    appLogger.error(`${method} ${path} -> 500 [DB ${pgErr.severity || 'ERROR'} ${pgErr.code || '?'}]`, {
      method, path, errorType: 'database',
      pgCode: pgErr.code, table: pgErr.table, hint: pgErr.hint, detail: pgErr.detail,
      message: err.message.split('\n')[0],
    });
  } else {
    // Generic unhandled error — capture to Sentry + structured log
    captureException(err, { method, path, errorType: errName });
    appLogger.error(`${method} ${path} -> 500 [${errName}] ${err.message}`, {
      method, path, errorType: errName,
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
    });
  }

  return c.json(
    {
      error: true,
      message: 'Internal server error',
      status: 500,
    },
    500
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
    404
  );
});

// === Start Server ===

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
║    /v1/platform   (sandbox lifecycle)                      ║
${config.KORTIX_DEPLOYMENTS_ENABLED ? '║    /v1/deployments (deploy lifecycle)                      ║\n' : ''}║    /v1/projects   (Git-backed projects)                    ║
${config.KORTIX_APPS_EXPERIMENTAL ? '║    /v1/projects/:id/apps  (experimental [[apps]])         ║\n' : ''}
║    /v1/setup      (setup & env management)                 ║
║    /v1/queue      (persistent message queue)               ║
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

// Load LLM pricing from models.dev (non-blocking if it fails).
// Awaited so pricing is available before the first billing request.
initModelPricing().catch((err) =>
  console.error('[startup] Model pricing init failed (will retry in 24h):', err),
);

// Schema readiness gate — blocks DB-dependent requests until push completes.
let schemaReady = false;
export function isSchemaReady() { return schemaReady; }

// Ensure DB schema exists before starting services that depend on it.
// This is idempotent — safe to run on every startup.
ensureSchema()
  .then(async () => {
    schemaReady = true;
    // V2 IAM hard-codes role permissions in iam/role-perms.ts, so the
    // boot-time system-role seed + membership-policy backfill from V1
    // are no longer needed. Permissions resolve directly from
    // account_members.account_role and project_members.project_role.
    startAccessControlCache();
    startDrainer();
    startTunnelService();
    startProjectMaintenance();
    startProjectTriggerScheduler();
    // IAM V2 time-bounded grants: tick every 60s, emit one audit event
    // per row that just transitioned to expired. Engine already filters
    // expired rows out of authorize() so correctness doesn't depend on
    // this — it's purely for the audit trail.
    {
      const { startGrantExpirySweeper } = await import('./iam/expiry-sweeper');
      startGrantExpirySweeper();
    }
  })
  .catch(async (err) => {
    console.error('[startup] ensureSchema failed, starting services anyway:', err);
    schemaReady = true;
    startAccessControlCache();
    startDrainer();
    startTunnelService();
    startProjectMaintenance();
    startProjectTriggerScheduler();
  });

// Graceful shutdown
async function shutdown(signal: string) {
  appLogger.info(`Shutting down gracefully`, { signal });
  stopDrainer();
  stopProjectTriggerScheduler();
  stopProjectMaintenance();
  stopModelPricing();
  stopTunnelService();
  stopAccessControlCache();
  // Flush observability data before exit
  await Promise.allSettled([appLogger.flush(), flushSentry()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Subdomain preview routing — `p{port}-{sandboxId}.localhost:{apiPort}/...`
// Handled at the Bun.serve level so the proxied app sees itself at root `/`
// (Hono can't match on the Host header). See `sandbox-proxy/subdomain.ts`.
import { handleSubdomainRequest, parsePreviewSubdomain } from './sandbox-proxy/subdomain';
import { matchPreviewWsPath, preparePreviewWsUpgrade, previewWsHandlers } from './sandbox-proxy/ws-proxy';

export default {
  port: config.PORT,

  async fetch(req: Request, server: any): Promise<Response | undefined> {
    const url = getRequestUrl(req, config.PORT);
    const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

    // Sandbox preview traffic includes OpenCode long-poll and SSE routes. Let
    // the proxy's own upstream timeout decide instead of Bun closing the client
    // socket early with an empty reply.
    if (url.pathname.includes('/v1/p/')) {
      server.timeout(req, 0);
    }

    // ── Subdomain preview routing ──────────────────────────────────────
    // Matches `p{port}-{sandboxId}.localhost:{apiPort}` regardless of path.
    // Same per-request long-poll/SSE timeout posture as /v1/p/.
    const host = req.headers.get('host') || '';
    if (parsePreviewSubdomain(host)) {
      server.timeout(req, 0);
      // WS-on-subdomain isn't wired yet (agent server's port-proxy is
      // HTTP-only). Reject the upgrade cleanly so the client falls back
      // gracefully instead of timing out.
      if (isWsUpgrade) {
        return new Response(
          JSON.stringify({ error: 'WebSocket upgrade on preview subdomain not implemented' }),
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

      if (!tunnelId) {
        return new Response(JSON.stringify({ error: 'Missing tunnelId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Rate limit WS connections (keyed by tunnelId to prevent connection spam)
      const { tunnelRateLimiter } = await import('./tunnel/core/rate-limiter');
      const wsRateCheck = tunnelRateLimiter.check('wsConnect', tunnelId);
      if (!wsRateCheck.allowed) {
        return new Response(JSON.stringify({
          error: 'Too many connection attempts',
          retryAfterMs: wsRateCheck.retryAfterMs,
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
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

    open(ws: { data: any; send: (data: any) => void; close: (code?: number, reason?: string) => void }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onOpen(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.open(ws as any);
        return;
      }
      // No other WS upgrades are accepted.
      try { ws.close(1011, 'unsupported websocket upgrade'); } catch {}
    },

    message(ws: { data: any; close: (code?: number, reason?: string) => void }, message: string | Buffer) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onMessage(ws.data.tunnelId, message);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.message(ws as any, message);
        return;
      }
    },

    close(ws: { data: any }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onClose(ws.data.tunnelId);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.close(ws as any);
        return;
      }
    },
  },
};

// Mark intentionally-unused imports so TS won't complain in cases the helpers
// are referenced only by deleted code paths.
void isKortixToken;
void getSupabase;
void verifySupabaseJwt;
void canAccessPreviewSandbox;
void validateSecretKey;
void supabaseAuth;
void combinedAuth;
 
