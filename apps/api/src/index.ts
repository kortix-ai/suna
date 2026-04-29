// ─── Observability (must be first — instruments before other imports) ────────
import './lib/sentry';
import { captureException, flushSentry, addBreadcrumb } from './lib/sentry';
import { logger as appLogger } from './lib/logger';
import { runWithContext, setContextField } from './lib/request-context';
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
import { sandboxProxyApp, resolveProvider, invalidateProviderCache } from './sandbox-proxy';
import { isProxyTokenStale, refreshSandboxProxyToken } from './platform/providers/justavps';
import { buildCanonicalSandboxAuthCommand } from './platform/services/sandbox-auth';
import { ensureLocalSandboxPublicBase } from './platform/services/local-public-base';
import { getSandboxBaseUrl, proxyToSandbox } from './sandbox-proxy/routes/local-preview';
import { validateSecretKey } from './repositories/api-keys';
import { isKortixToken } from './shared/crypto';
import { getSupabase } from './shared/supabase';
import { verifySupabaseJwt } from './shared/jwt-verify';
import { canAccessPreviewSandbox } from './shared/preview-ownership';
import { setupApp } from './setup';
import { providersApp } from './providers/routes';
import { secretsApp } from './secrets/routes';
import { integrationsApp } from './integrations';
import { queueApp, startDrainer, stopDrainer } from './queue';
import { serversApp } from './servers';
import { parallelApp } from './routes/parallel';
// WoA is now mounted under the router at /v1/router/woa (see router/index.ts)
import { supabaseAuth, combinedAuth } from './middleware/auth';
import { ensureSchema } from './ensure-schema';
import { initModelPricing, stopModelPricing } from './router/config/model-pricing';
import { tunnelApp, wsHandlers as tunnelWsHandlers, startTunnelService, stopTunnelService, getTunnelServiceStatus } from './tunnel';
import { startSandboxHealthMonitor, stopSandboxHealthMonitor } from './platform/services/sandbox-health';
import { startProvisionPoller, stopProvisionPoller } from './platform/services/sandbox-provision-poller';
import { defaultSandboxAutoUpdatePolicy, startSandboxAutoUpdateLoop, stopSandboxAutoUpdateLoop } from './update/auto-update';
import { startInviteCleanup, stopInviteCleanup } from './teams';
import { db as appDb } from './shared/db';
import { startAutoReplenish, stopAutoReplenish } from './pool';
import { accessControlApp } from './access-control';
import { startAccessControlCache, stopAccessControlCache } from './shared/access-control-cache';
import { legacyApp } from './legacy';
// [channels v2] Old channel routes removed — channels now managed via sandbox CLI (kchannel, ktelegram, kslack)
import { adminApp } from './admin';
import { sandboxPoolAdminApp } from './platform/routes/sandbox-pool-admin';
import { oauthApp } from './oauth';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function buildDockerEnvWriteCommand(payload: Record<string, string>, targetDir: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `mkdir -p ${targetDir} && ENV_WRITE_PAYLOAD_B64=${shellQuote(payloadB64)} python3 - <<PY
import base64, json, os
from pathlib import Path

target_dir = Path(${JSON.stringify(targetDir)})
target_dir.mkdir(parents=True, exist_ok=True)
payload = json.loads(base64.b64decode(os.environ["ENV_WRITE_PAYLOAD_B64"]).decode("utf-8"))
for key, value in payload.items():
    (target_dir / key).write_text(value)
PY`;
}

function buildBootstrapUpdateCommand(payload: Record<string, string>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `mkdir -p /workspace/.secrets && BOOTSTRAP_UPDATE_B64=${shellQuote(payloadB64)} python3 - <<PY
import base64, json, os
from pathlib import Path

path = Path("/workspace/.secrets/.bootstrap-env.json")
try:
    data = json.loads(path.read_text())
except Exception:
    data = {}

data.update(json.loads(base64.b64decode(os.environ["BOOTSTRAP_UPDATE_B64"]).decode("utf-8")))
tmp = path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(data))
tmp.replace(path)
PY`;
}

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
const justavpsOrigins = [
  'https://justavps.com',
  'http://localhost:3001',
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
    ...justavpsOrigins,
    ...localOrigins,  // Always include — needed for local dev and self-hosted
    ...extraOrigins,
  ]),
];

app.use(
  '*',
  cors({
    origin: corsOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Kortix-Token', 'X-Api-Key', 'Accept'],
    credentials: true,
  })
);

// ─── Request context (AsyncLocalStorage) ────────────────────────────────────
// Must be FIRST — wraps the entire request lifecycle so all downstream code
// (auth, route handlers, console.error calls) automatically gets context fields
// (requestId, userId, accountId, sandboxId) attached to every log.
app.use('*', async (c, next) => {
  await runWithContext(c.req.method, c.req.path, async () => {
    // Auto-extract sandboxId from common URL patterns
    const path = c.req.path;
    const sbMatch = path.match(/\/sandbox(?:es)?\/([^/]+)/) ||
                    path.match(/\/p\/([^/]+)/);
    if (sbMatch) setContextField('sandboxId', sbMatch[1]);
    await next();
  });
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
  const userId = c.get('userId');
  const accountId = c.get('accountId');
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
  const isProxyLongPoll = isSandboxProxyPath && path.includes('/global/event');
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

  // Log slow requests (>5s) and server errors to structured logger
  if (!isExpectedProxyNoise && (status >= 500 || duration > 5000)) {
    appLogger.warn(`Slow/error request: ${method} ${path} ${status} ${duration}ms`, {
      status,
      duration,
    });
  }
});

// Pretty JSON in dev mode for easier debugging
if (config.INTERNAL_KORTIX_ENV === 'dev') {
  app.use('*', prettyJSON());
}

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
    env: config.ENV_MODE,
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
    env: config.ENV_MODE,
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

// GET /v1/accounts — returns user's accounts.
// Dual-read: kortix.account_members first, falls back to basejump.account_user.
app.get('/v1/accounts', supabaseAuth, async (c: any) => {
  const userId = c.get('userId') as string;
  const userEmail = c.get('userEmail') as string;

  const { eq } = await import('drizzle-orm');
  const { accountMembers, accounts, accountUser } = await import('@kortix/db');
  const { db } = await import('./shared/db');

  // 1. Try kortix.account_members (new table)
  try {
    const memberships = await db
      .select({
        accountId: accountMembers.accountId,
        accountRole: accountMembers.accountRole,
        name: accounts.name,
        personalAccount: accounts.personalAccount,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
      })
      .from(accountMembers)
      .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
      .where(eq(accountMembers.userId, userId));

    if (memberships.length > 0) {
      return c.json(memberships.map(m => ({
        account_id: m.accountId,
        name: m.name || userEmail || 'User',
        slug: m.accountId.slice(0, 8),
        personal_account: m.personalAccount,
        created_at: m.createdAt?.toISOString() ?? new Date().toISOString(),
        updated_at: m.updatedAt?.toISOString() ?? new Date().toISOString(),
        account_role: m.accountRole || 'owner',
        is_primary_owner: m.accountRole === 'owner',
      })));
    }
  } catch {
    // Table doesn't exist yet — continue to basejump fallback
  }

  // 2. Fall back to basejump.account_user (legacy, cloud prod)
  try {
    const legacyMemberships = await db
      .select({
        accountId: accountUser.accountId,
        accountRole: accountUser.accountRole,
      })
      .from(accountUser)
      .where(eq(accountUser.userId, userId));

    if (legacyMemberships.length > 0) {
      return c.json(legacyMemberships.map(m => ({
        account_id: m.accountId,
        name: userEmail || 'User',
        slug: m.accountId.slice(0, 8),
        personal_account: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_role: m.accountRole || 'owner',
        is_primary_owner: m.accountRole === 'owner',
      })));
    }
  } catch {
    // basejump doesn't exist — continue to fallback
  }

  // 3. No memberships anywhere — return userId as personal account
  return c.json([
    {
      account_id: userId,
      name: userEmail || 'User',
      slug: userId.slice(0, 8),
      personal_account: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      account_role: 'owner',
      is_primary_owner: true,
    },
  ]);
});


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
app.route('/v1/billing', billingApp);   // /v1/billing/account-state, /v1/billing/webhooks/*, /v1/billing/setup/*
app.route('/v1/account', accountDeletionApp); // account deletion status/request/cancel/immediate
app.route('/v1/platform', platformApp); // /v1/platform/providers, /v1/platform/sandbox/*, /v1/platform/sandbox/version
if (config.KORTIX_DEPLOYMENTS_ENABLED) {
  const { deploymentsApp } = await import('./deployments');
  app.route('/v1/deployments', deploymentsApp); // /v1/deployments/*
}
app.route('/v1/pipedream', integrationsApp);

// Access control — public endpoints for signup gating
app.route('/v1/access', accessControlApp); // /v1/access/signup-status, /v1/access/check-email, /v1/access/request-access

// Legacy thread migration — authenticated endpoints
app.route('/v1/legacy', legacyApp); // /v1/legacy/threads, /v1/legacy/threads/:id/migrate

// [channels v2] Old webhook forwarding and channel CRUD removed.
// Channels are now managed inside the sandbox via CLI (kchannel, ktelegram, kslack).
// Webhooks go directly to the sandbox via share URLs.

// Setup — local/self-hosted only. Disabled in cloud mode (not needed, exposes admin surface).
if (config.isLocal()) {
  app.route('/v1/setup', setupApp);        // /v1/setup/install-status (public), rest (auth inside router)
}
app.route('/v1/admin', adminApp);          // /v1/admin/api/sandboxes, /v1/admin/api/env, /v1/admin/api/health, etc.
app.route('/v1/admin/sandbox-pool', sandboxPoolAdminApp); // /v1/admin/sandbox-pool/health, /v1/admin/sandbox-pool/list, etc.

// OAuth2 provider — public token endpoint, auth on authorize/consent
app.route('/v1/oauth', oauthApp);

// All remaining routes require authentication (JWT or kortix_ token).
app.use('/v1/providers/*', combinedAuth);
app.route('/v1/providers', providersApp);   // /v1/providers, /v1/providers/schema, /v1/providers/:id/connect, /v1/providers/:id/disconnect, /v1/providers/health

app.use('/v1/secrets/*', combinedAuth);
app.route('/v1/secrets', secretsApp);       // /v1/secrets, /v1/secrets/:key (PUT/DELETE)

app.use('/v1/servers/*', combinedAuth);
app.route('/v1/servers', serversApp);        // /v1/servers, /v1/servers/:id, /v1/servers/sync

app.use('/v1/queue/*', combinedAuth);
app.route('/v1/queue', queueApp);            // /v1/queue/sessions/:id, /v1/queue/messages/:id, /v1/queue/all, /v1/queue/status

app.use('/v1/agents/parallel', combinedAuth);
app.route('/v1/agents/parallel', parallelApp); // POST /v1/agents/parallel — fan-out N agent sessions

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

// ── Kortix API — proxies /v1/kortix/* to the sandbox's /kortix/* ─────────────
// Direct server-to-server proxy. Avoids double-CORS from the /v1/p/ path.
// Auth: Supabase JWT (global middleware). Sandbox auth: INTERNAL_SERVICE_KEY.
import { kortixProxyHandler } from './routes/kortix-projects';
app.use('/v1/kortix/*', combinedAuth);
app.use('/v1/kortix', combinedAuth);
app.all('/v1/kortix/*', kortixProxyHandler);
app.all('/v1/kortix', kortixProxyHandler);

// Preview Proxy — unified route for both cloud (Daytona) and local mode.
// Pattern: /v1/p/{sandboxId}/{port}/* for ALL modes.
// Cloud:  sandboxId = Daytona external ID → proxied via Daytona SDK
// Local:  sandboxId = container name (e.g. 'kortix-sandbox') → Docker DNS resolution
// JustAVPS: sandboxId → CF Worker proxy at {port}--{slug}.kortix.cloud
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

// ─── Auto-register local Docker sandbox in DB ──────────────────────────────

/**
 * Ensure a valid KORTIX_TOKEN exists in the DB and is synced to the sandbox.
 *
 * Architecture:
 *   Source of truth: kortix.api_keys table (hash) + sandboxes.config.serviceKey (plaintext)
 *   Delivery:        POST to sandbox /env API → triple-write (s6 + bootstrap + SecretStore) + auto-restart
 *   Fallback:        docker exec raw write when /env API is unreachable (sandbox still booting)
 *
 * This function is idempotent: if a valid key already exists in the DB AND the
 * sandbox already has it, this is a no-op. It only re-issues when the key is
 * actually missing or invalid.
 */
async function injectSandboxToken(sandboxId: string, accountId: string): Promise<string> {
  const { db } = await import('./shared/db');
  const { kortixApiKeys } = await import('@kortix/db');
  const { sandboxes } = await import('@kortix/db');
  const { eq, and } = await import('drizzle-orm');
  const { execSync: rawExecSync } = await import('child_process');
  const rawDockerHost = config.DOCKER_HOST || process.env.DOCKER_HOST || '';
  const dockerHost = rawDockerHost.startsWith('/') ? `unix://${rawDockerHost}` : rawDockerHost;
  const dockerEnv = { ...process.env, DOCKER_HOST: dockerHost.startsWith('/') ? `unix://${dockerHost}` : dockerHost };
  // Use Docker DNS when on a shared network (self-hosted), localhost when on host (dev)
  const sandboxBaseUrl = config.SANDBOX_NETWORK
    ? `http://${config.SANDBOX_CONTAINER_NAME}:8000`
    : `http://localhost:${config.SANDBOX_PORT_BASE}`;

  const waitForSandboxMaster = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${sandboxBaseUrl}/kortix/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok || res.status === 503) return;
      } catch {
        // keep polling until startup finishes
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  // Resolve how sandbox reaches kortix-api
  const rawUrl = (config.KORTIX_URL || '').replace(/\/v1\/router\/?$/, '');
  let kortixApiUrl = `http://host.docker.internal:${config.PORT}`;
  try {
    const parsed = new URL(rawUrl || `http://localhost:${config.PORT}`);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'host.docker.internal';
      kortixApiUrl = parsed.toString().replace(/\/$/, '');
    } else if (rawUrl) {
      kortixApiUrl = rawUrl.replace(/\/$/, '');
    }
  } catch { /* keep default */ }

  const { createApiKey, validateSecretKey } = await import('./repositories/api-keys');

  await waitForSandboxMaster();

  // ─── Resolve the token: reuse existing or create new ───────────────────
  const [sandbox] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, sandboxId));
  const existingServiceKey = (sandbox?.config as any)?.serviceKey as string | undefined;
  let token: string;

  if (existingServiceKey) {
    const validation = await validateSecretKey(existingServiceKey).catch(() => ({ isValid: false }));
    if (validation.isValid) {
      token = existingServiceKey;
      console.log('[startup] Reusing existing valid KORTIX_TOKEN from sandbox config');
    } else {
      // Key exists in config but not valid in DB — re-issue
      console.log('[startup] Existing KORTIX_TOKEN invalid in DB — re-issuing');
      const [oldKey] = await db.select().from(kortixApiKeys)
        .where(and(eq(kortixApiKeys.sandboxId, sandboxId), eq(kortixApiKeys.type, 'sandbox')));
      if (oldKey) await db.delete(kortixApiKeys).where(eq(kortixApiKeys.keyId, oldKey.keyId));
      const newKey = await createApiKey({ sandboxId, accountId, title: 'Sandbox Token', type: 'sandbox' });
      token = newKey.secretKey;
      await db.update(sandboxes)
        .set({ config: { serviceKey: token }, updatedAt: new Date() })
        .where(eq(sandboxes.sandboxId, sandboxId));
    }
  } else {
    // No key at all — first provision
    console.log('[startup] No KORTIX_TOKEN in sandbox config — creating');
    const newKey = await createApiKey({ sandboxId, accountId, title: 'Sandbox Token', type: 'sandbox' });
    token = newKey.secretKey;
    await db.update(sandboxes)
      .set({ config: { serviceKey: token }, updatedAt: new Date() })
      .where(eq(sandboxes.sandboxId, sandboxId));
  }

  const authCandidates = Array.from(new Set([token, config.INTERNAL_SERVICE_KEY].filter(Boolean)));

  const readSandboxEnvValue = async (key: string): Promise<string | null> => {
    for (const authToken of authCandidates) {
      try {
        const res = await fetch(`${sandboxBaseUrl}/env/${key}`, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as Record<string, string | null>;
        return data?.[key] ?? null;
      } catch {
        // try next candidate
      }
    }
    return null;
  };

  // ─── Check if sandbox already has the correct token ─────────────────────
  // Read the sandbox's current KORTIX_TOKEN via its /env API. If it already
  // matches, skip the sync entirely — no restart, no downtime.
  const sandboxAlreadyHasToken = async (): Promise<boolean> => (await readSandboxEnvValue('KORTIX_TOKEN')) === token;

  // Also check KORTIX_API_URL
  const sandboxAlreadyHasUrl = async (): Promise<boolean> => (await readSandboxEnvValue('KORTIX_API_URL')) === kortixApiUrl;
  const sandboxAlreadyHasInboundKey = async (): Promise<boolean> => (await readSandboxEnvValue('INTERNAL_SERVICE_KEY')) === token;
  const sandboxAlreadyHasYoloKey = async (): Promise<boolean> => {
    if (config.ENV_MODE !== 'cloud') return true;
    return (await readSandboxEnvValue('KORTIX_YOLO_API_KEY')) === token;
  };
  const sandboxAlreadyHasYoloUrl = async (): Promise<boolean> => {
    if (config.ENV_MODE !== 'cloud') return true;
    return (await readSandboxEnvValue('KORTIX_YOLO_URL')) === config.KORTIX_YOLO_URL;
  };

  // Fast path: if the sandbox already has the correct token AND URL, skip sync.
  // This is the common case on normal startup — no restart, no downtime.
  const [hasToken, hasUrl, hasInboundKey, hasYoloKey, hasYoloUrl] = await Promise.all([
    sandboxAlreadyHasToken(),
    sandboxAlreadyHasUrl(),
    sandboxAlreadyHasInboundKey(),
    sandboxAlreadyHasYoloKey(),
    sandboxAlreadyHasYoloUrl(),
  ]);
  if (hasToken && hasUrl && hasInboundKey && hasYoloKey && hasYoloUrl) {
    console.log('[startup] Sandbox already has correct auth bundle + API URL — skipping sync');
    // Still ensure ONBOARDING_COMPLETE is set for self-hosted mode
    if (config.SANDBOX_NETWORK) {
      try {
        const res = await fetch(`${sandboxBaseUrl}/env/ONBOARDING_COMPLETE`, {
          headers: { Authorization: `Bearer ${authCandidates[0]}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, string | null>;
          if (data?.ONBOARDING_COMPLETE !== 'true') {
            await fetch(`${sandboxBaseUrl}/env/ONBOARDING_COMPLETE`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authCandidates[0]}` },
              body: JSON.stringify({ value: 'true' }),
              signal: AbortSignal.timeout(5_000),
            });
            console.log('[startup] Set ONBOARDING_COMPLETE=true for self-hosted');
          }
        }
      } catch { /* non-critical */ }
    }
    return token;
  }

  console.log(`[startup] Sandbox needs token sync (hasToken=${hasToken}, hasUrl=${hasUrl}, hasInboundKey=${hasInboundKey}, hasYoloKey=${hasYoloKey}, hasYoloUrl=${hasYoloUrl})`);

  // ─── Sync token to sandbox ─────────────────────────────────────────────
  // Primary: POST to sandbox's /env API (handles triple-write + restart)
  // Fallback: docker exec raw write (when /env API is not yet up)
  // NOTE: The /env POST handler is now idempotent — it won't restart
  // OpenCode if the values are unchanged (belt-and-suspenders with the check above).
  const keysToSync: Record<string, string> = {
    KORTIX_TOKEN: token,
    INTERNAL_SERVICE_KEY: token,
    TUNNEL_TOKEN: token,
    KORTIX_API_URL: kortixApiUrl,
    TUNNEL_API_URL: kortixApiUrl,
    ...(config.ENV_MODE === 'cloud' ? { KORTIX_YOLO_API_KEY: token, KORTIX_YOLO_URL: config.KORTIX_YOLO_URL } : {}),
    ...(config.SANDBOX_NETWORK ? { ONBOARDING_COMPLETE: 'true' } : {}),
  };

  const syncViaEnvApi = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${sandboxBaseUrl}/env`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authCandidates[0]}`,
        },
        body: JSON.stringify({ keys: keysToSync }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const result = await res.json() as { restarted?: boolean };
        console.log(`[startup] KORTIX_TOKEN synced via /env API (restarted=${result?.restarted ?? 'unknown'})`);
        return true;
      }
      console.warn(`[startup] /env API returned ${res.status} for primary auth candidate — trying fallback candidates`);
      for (const authToken of authCandidates.slice(1)) {
        const retry = await fetch(`${sandboxBaseUrl}/env`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ keys: keysToSync }),
          signal: AbortSignal.timeout(10_000),
        });
        if (retry.ok) {
          const result = await retry.json() as { restarted?: boolean };
          console.log(`[startup] KORTIX_TOKEN synced via /env API fallback (restarted=${result?.restarted ?? 'unknown'})`);
          return true;
        }
      }
      console.warn('[startup] /env API auth candidates exhausted — falling back to docker exec');
      return false;
    } catch (e: any) {
      console.warn(`[startup] /env API unreachable (${e?.message}) — falling back to docker exec`);
      return false;
    }
  };

  const syncViaDockerExec = (): boolean => {
    try {
      if (config.SANDBOX_NETWORK) {
        rawExecSync(
          `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ${shellQuote(buildDockerEnvWriteCommand(keysToSync, '/run/s6/container_environment'))}`,
          { stdio: 'pipe', timeout: 15_000, env: dockerEnv },
        );
        rawExecSync(
          `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ${shellQuote(buildBootstrapUpdateCommand({
            KORTIX_TOKEN: token,
            KORTIX_API_URL: kortixApiUrl,
            INTERNAL_SERVICE_KEY: token,
            TUNNEL_TOKEN: token,
            ...(config.ENV_MODE === 'cloud' ? { KORTIX_YOLO_API_KEY: token, KORTIX_YOLO_URL: config.KORTIX_YOLO_URL } : {}),
          }))}`,
          { stdio: 'pipe', timeout: 15_000, env: dockerEnv },
        ).toString();
      } else {
        forceLocalDockerAuthBundle();
      }
      // No restart — getEnv() reads from s6 env dir live. OpenCode picks up
      // the new values on the next tool call without a process restart.
      console.log('[startup] KORTIX_TOKEN synced via docker exec fallback + bootstrap file');
      return true;
    } catch (e: any) {
      console.error(`[startup] docker exec fallback failed: ${e?.message}`);
      return false;
    }
  };

  const forceLocalDockerAuthBundle = (): void => {
    if (config.SANDBOX_NETWORK) return;
    rawExecSync(
      `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ${shellQuote(buildCanonicalSandboxAuthCommand(token, kortixApiUrl))}`,
      { stdio: 'pipe', timeout: 15_000, env: dockerEnv },
    );
  };

  const readLocalDockerAuthBundle = (): Record<string, string> | null => {
    if (config.SANDBOX_NETWORK) return null;
    try {
      const raw = rawExecSync(
        `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} python3 -c ${shellQuote("from pathlib import Path; import json; keys=['KORTIX_TOKEN','INTERNAL_SERVICE_KEY','TUNNEL_TOKEN']; print(json.dumps({k:(Path('/run/s6/container_environment')/k).read_text() for k in keys}))")}`,
        { stdio: 'pipe', timeout: 15_000, env: dockerEnv },
      ).toString();
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return null;
    }
  };

  // Try /env API first, fall back to docker exec
  const synced = await syncViaEnvApi() || syncViaDockerExec();
  if (!synced) {
    console.error('[startup] FATAL: Could not sync KORTIX_TOKEN to sandbox. LLM calls will fail with 401.');
    return token;
  }

  try {
    if (!config.SANDBOX_NETWORK) {
      let enforced = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        forceLocalDockerAuthBundle();
        const bundle = readLocalDockerAuthBundle();
        if (
          bundle?.KORTIX_TOKEN === token &&
          bundle?.INTERNAL_SERVICE_KEY === token &&
          bundle?.TUNNEL_TOKEN === token
        ) {
          enforced = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!enforced) {
        throw new Error('Canonical auth bundle did not stick after repeated enforcement');
      }
    }
    console.log('[startup] Enforced canonical sandbox auth bundle after sync');
  } catch (e: any) {
    console.error(`[startup] Failed to enforce canonical sandbox auth bundle: ${e?.message || e}`);
  }
  return token;
}

async function ensureLocalSandboxRegistered() {
  const { db } = await import('./shared/db');
  const { sandboxes } = await import('@kortix/db');
  const { eq, and } = await import('drizzle-orm');
  const { execSync } = await import('child_process');

  // Use a well-known account ID for the self-hosted single-owner case.
  // When Supabase auth is active, the real user ID will be used via POST /init.
  // This bootstrap is for the case where we need a sandbox before any user logs in.
  const CONTAINER_NAME = config.SANDBOX_CONTAINER_NAME;
  const portBase = config.SANDBOX_PORT_BASE;
  const baseUrl = `http://localhost:${portBase}`;
  const ensureLocalContainerRunning = async (): Promise<void> => {
    const { LocalDockerProvider } = await import('./platform/providers/local-docker');
    const provider = new LocalDockerProvider();
    await provider.ensure();
  };

  // Helper: check if the Docker container actually exists and is running
  const isContainerRunning = (): boolean => {
    try {
      const rawDockerHost = config.DOCKER_HOST || process.env.DOCKER_HOST || '';
      const dockerHost = rawDockerHost.startsWith('/') ? `unix://${rawDockerHost}` : rawDockerHost;
      const env = { ...process.env, DOCKER_HOST: dockerHost.startsWith('/') ? `unix://${dockerHost}` : dockerHost };
      const out = execSync(`docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME}`, {
        encoding: 'utf-8',
        timeout: 5000,
        env,
      }).trim();
      return out === 'true';
    } catch {
      return false;
    }
  };

  // Check if already registered
  const [existing] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.externalId, CONTAINER_NAME));

  if (existing) {
    const containerRunning = isContainerRunning();

    if (!containerRunning) {
      console.log(`[startup] Container ${CONTAINER_NAME} not running — recreating/starting before registration`);
      await ensureLocalContainerRunning();
    }

    // Container is running — ensure DB reflects active status
    if (existing.status !== 'active' || existing.baseUrl !== baseUrl) {
      await db
        .update(sandboxes)
        .set({ status: 'active', baseUrl, updatedAt: new Date() })
        .where(eq(sandboxes.sandboxId, existing.sandboxId));
      console.log(`[startup] Updated local sandbox registration (${existing.sandboxId})`);
    } else {
      console.log(`[startup] Local sandbox already registered (${existing.sandboxId})`);
    }
    // Inject token — injectSandboxToken is now idempotent: it checks if the
    // sandbox already has the correct token and skips sync + restart if so.
    // Safe to call on every tick without causing OpenCode restarts.
    const token = await injectSandboxToken(existing.sandboxId, existing.accountId);
    try {
      await ensureLocalSandboxPublicBase(baseUrl, token);
      console.log('[startup] Local sandbox PUBLIC_BASE_URL synced');
    } catch (err) {
      console.warn('[startup] Failed to sync local PUBLIC_BASE_URL:', err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // No existing sandbox — auto-provision for local single-user setup.
  // Only create if the container is actually running (image pulled, container started).
  const { accounts } = await import('@kortix/db');
  const [account] = await db.select().from(accounts).limit(1);
  if (!account) {
    console.log('[startup] No account yet — sandbox will be created on first login via POST /init');
    return;
  }

  const containerRunning = isContainerRunning();
  if (!containerRunning) {
    console.log(`[startup] Container ${CONTAINER_NAME} not running — creating before auto-provision`);
    await ensureLocalContainerRunning();
  }

  const sandbox = await db
    .insert(sandboxes)
    .values({
      accountId: account.accountId,
      name: 'sandbox-local',
      provider: 'local_docker',
      status: 'active',
      externalId: CONTAINER_NAME,
      baseUrl,
      config: {},
      metadata: { autoUpdate: defaultSandboxAutoUpdatePolicy(SANDBOX_VERSION) },
    })
    .returning()
    .then(([r]) => r);

  const token = await injectSandboxToken(sandbox.sandboxId, account.accountId);
  try {
    await ensureLocalSandboxPublicBase(baseUrl, token);
    console.log('[startup] Local sandbox PUBLIC_BASE_URL synced');
  } catch (err) {
    console.warn('[startup] Failed to sync local PUBLIC_BASE_URL:', err instanceof Error ? err.message : String(err));
  }
  console.log(`[startup] Local sandbox auto-provisioned (${sandbox.sandboxId}), token injected`);
}

let localSandboxHealTimer: ReturnType<typeof setInterval> | null = null;
let localSandboxHealRunning = false;

function startLocalSandboxSelfHeal(): void {
  if (localSandboxHealTimer || !config.isLocalDockerEnabled() || !config.DATABASE_URL) return;

  const run = async () => {
    if (localSandboxHealRunning) return;
    localSandboxHealRunning = true;
    try {
      await ensureLocalSandboxRegistered();
    } catch (err) {
      console.error('[startup] Local sandbox self-heal failed:', err);
    } finally {
      localSandboxHealRunning = false;
    }
  };

  localSandboxHealTimer = setInterval(() => {
    void run();
  }, 60_000);

  console.log('[startup] Local sandbox self-heal started (interval: 60s)');
}

// === Start Server ===

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Kortix API Starting                      ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${config.PORT.toString().padEnd(49)}║
║  Mode: ${config.ENV_MODE.padEnd(49)}║
║  Env:  ${config.INTERNAL_KORTIX_ENV.padEnd(49)}║
╠═══════════════════════════════════════════════════════════╣
║  Services:                                                ║
║    /v1/router     (search, LLM, proxy)                    ║
║    /v1/billing    (subscriptions, credits, webhooks)       ║
║    /v1/platform   (sandbox lifecycle)                      ║
${config.KORTIX_DEPLOYMENTS_ENABLED ? '║    /v1/deployments (deploy lifecycle)                      ║\n' : ''}║    /v1/pipedream   (Pipedream OAuth integrations)           ║
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
    startAccessControlCache();
    startDrainer();
    startTunnelService();
    startAutoReplenish();
    startInviteCleanup(appDb);

    if (config.isLocalDockerEnabled() && config.DATABASE_URL) {
      // Non-blocking: sandbox registration + token sync runs in background.
      // Must NOT await — the /env API call can take seconds and would block
      // all route handlers from being ready. The self-heal timer ensures
      // convergence even if the first attempt fails.
      ensureLocalSandboxRegistered().catch((err) =>
        console.error('[startup] Failed to register local sandbox:', err),
      );
      startLocalSandboxSelfHeal();
      startSandboxHealthMonitor();
    }

    // Start provision poller for cloud mode (compensates for broken/missing webhooks)
    if (config.isJustAVPSEnabled()) {
      startProvisionPoller();
    }
    startSandboxAutoUpdateLoop();
  })
  .catch(async (err) => {
    console.error('[startup] ensureSchema failed, starting services anyway:', err);
    schemaReady = true;
    startAccessControlCache();
    startDrainer();
    startTunnelService();
    startAutoReplenish();
    startInviteCleanup(appDb);

    if (config.isLocalDockerEnabled() && config.DATABASE_URL) {
      ensureLocalSandboxRegistered().catch((e) =>
        console.error('[startup] Failed to register local sandbox:', e),
      );
      startLocalSandboxSelfHeal();
      startSandboxHealthMonitor();
    }

    if (config.isJustAVPSEnabled()) {
      startProvisionPoller();
    }
    startSandboxAutoUpdateLoop();
  });

// Graceful shutdown
async function shutdown(signal: string) {
  appLogger.info(`Shutting down gracefully`, { signal });
  stopDrainer();
  stopModelPricing();
  stopTunnelService();
  stopSandboxHealthMonitor();
  stopProvisionPoller();
  stopSandboxAutoUpdateLoop();
  stopAutoReplenish();
  stopAccessControlCache();
  stopInviteCleanup();
  // Flush observability data before exit
  await Promise.allSettled([appLogger.flush(), flushSentry()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── WebSocket proxy for sandbox PTY ─────────────────────────────────────────
// The Bun server needs to handle WebSocket upgrades at the top level.
// We intercept WS upgrade requests for /v1/p/{sandboxId}/* and proxy them
// to the sandbox's Kortix Master (which further proxies to OpenCode).

const WS_CONNECT_TIMEOUT_MS = 10_000;
const WS_BUFFER_MAX_BYTES = 1024 * 1024; // 1MB
const WS_IDLE_TIMEOUT_MS = 5 * 60_000;   // 5min

interface WsProxyData {
  targetUrl: string;
  upstreamHeaders?: Record<string, string>;
  subprotocol?: string;
  upstream: WebSocket | null;
  buffered: (string | Buffer | ArrayBuffer)[];
  bufferBytes: number;
  connectTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

function clearWsTimers(data: WsProxyData) {
  if (data.connectTimer) { clearTimeout(data.connectTimer); data.connectTimer = null; }
  if (data.idleTimer) { clearTimeout(data.idleTimer); data.idleTimer = null; }
}

function resetIdleTimer(ws: { data: WsProxyData; close: (code?: number, reason?: string) => void }) {
  if (ws.data.idleTimer) clearTimeout(ws.data.idleTimer);
  ws.data.idleTimer = setTimeout(() => {
    console.warn(`[sandbox-proxy] WS idle timeout`);
    try { ws.close(1000, 'idle timeout'); } catch {}
  }, WS_IDLE_TIMEOUT_MS);
}

let activeWsConnections = 0;

// ── Subdomain preview routing ───────────────────────────────────────────────
// Pattern: p{port}-{sandboxId}.localhost:{serverPort}
// Parsed from the Host header before Hono routing kicks in.

const SUBDOMAIN_REGEX = /^p(\d+)-([^.]+)\.localhost/;
const PREVIEW_SESSION_COOKIE = '__preview_session';

function parsePreviewSubdomain(host: string): { port: number; sandboxId: string } | null {
  const match = host.match(SUBDOMAIN_REGEX);
  if (!match) return null;
  const port = parseInt(match[1], 10);
  if (isNaN(port) || port < 1 || port > 65535) return null;
  return { port, sandboxId: match[2] };
}

function isLocalPreviewHost(host: string): boolean {
  const hostname = host.split(':')[0]?.toLowerCase() || '';
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}

function extractCookieToken(req: Request): string | null {
  const cookieHeader = req.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${PREVIEW_SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function validatePreviewToken(token: string, sandboxId: string): Promise<boolean> {
  if (isKortixToken(token)) {
    const result = await validateSecretKey(token);
    return !!result.isValid && !!result.accountId && await canAccessPreviewSandbox({
      previewSandboxId: sandboxId,
      accountId: result.accountId,
    });
  }
  // Fast path: local JWT verification (no network roundtrip)
  const local = await verifySupabaseJwt(token);
  if (local.ok) {
    return canAccessPreviewSandbox({
      previewSandboxId: sandboxId,
      userId: local.userId,
    });
  }
  // Definitively invalid (bad sig, expired, malformed) — reject without network call
  if (local.reason !== 'no-keys' && local.reason !== 'no-key-for-kid') return false;
  // JWKS not yet available — fall back to network call
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return false;
    return canAccessPreviewSandbox({
      previewSandboxId: sandboxId,
      userId: user.id,
    });
  } catch {
    return false;
  }
}

// ── Local-mode session tracking ─────────────────────────────────────────────
// Once a subdomain is authenticated via Bearer header on the first request,
// all subsequent requests to that subdomain pass through without auth.
// This avoids third-party cookie issues in iframes (Chrome blocks them).
// Like ngrok free tier — auth on first load, then open access.
// Map key: "p{port}-{sandboxId}" → timestamp when authenticated.
const authenticatedSubdomains = new Map<string, number>();
const AUTH_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getSubdomainKey(sandboxId: string, port: number): string {
  return `p${port}-${sandboxId}`;
}

function isSubdomainAuthenticated(sandboxId: string, port: number): boolean {
  const key = getSubdomainKey(sandboxId, port);
  const ts = authenticatedSubdomains.get(key);
  if (!ts) return false;
  if (Date.now() - ts > AUTH_SESSION_TTL_MS) {
    authenticatedSubdomains.delete(key);
    return false;
  }
  return true;
}

function markSubdomainAuthenticated(sandboxId: string, port: number): void {
  authenticatedSubdomains.set(getSubdomainKey(sandboxId, port), Date.now());
}

function getRequestedWsProtocol(req: Request): string | undefined {
  const raw = req.headers.get('sec-websocket-protocol');
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim();
  return first || undefined;
}

function buildWsUpgradeHeaders(req: Request): Record<string, string> | undefined {
  const protocol = getRequestedWsProtocol(req);
  return protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined;
}

// Periodic cleanup of expired sessions (every 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of authenticatedSubdomains) {
    if (now - ts > AUTH_SESSION_TTL_MS) authenticatedSubdomains.delete(key);
  }
}, 30 * 60 * 1000);

/** Build WS target URL for local_docker sandbox. */
function buildLocalDockerWsTarget(sandboxId: string, port: number, remainingPath: string, searchParams: URLSearchParams, serviceKey?: string): { url: string; headers?: Record<string, string> } {
  const sandboxBaseUrl = getSandboxBaseUrl(sandboxId);
  const wsBase = sandboxBaseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  const targetPath = port === 8000 ? remainingPath : `/proxy/${port}${remainingPath}`;

  const upstreamParams = new URLSearchParams(searchParams);
  upstreamParams.delete('token');
  const authToken = serviceKey || config.INTERNAL_SERVICE_KEY;
  if (authToken) {
    upstreamParams.set('token', authToken);
  }
  const search = upstreamParams.toString() ? `?${upstreamParams.toString()}` : '';
  return { url: `${wsBase}${targetPath}${search}` };
}

/** Build WS target URL for justavps sandbox (routes through CF Worker proxy). */
function buildJustavpsWsTarget(opts: {
  port: number;
  remainingPath: string;
  slug: string;
  serviceKey?: string;
  proxyToken?: string;
}): { url: string; headers?: Record<string, string> } {
  const proxyDomain = config.JUSTAVPS_PROXY_DOMAIN;
  const cfBase = `wss://${opts.port}--${opts.slug}.${proxyDomain}`;
  const params = new URLSearchParams();
  if (opts.serviceKey) params.set('token', opts.serviceKey);
  const search = params.toString() ? `?${params.toString()}` : '';
  const headers: Record<string, string> = {};
  if (opts.proxyToken) headers['X-Proxy-Token'] = opts.proxyToken;
  return { url: `${cfBase}${opts.remainingPath}${search}`, headers };
}

/**
 * Resolve the upstream WebSocket target for a sandbox, dispatching by provider.
 * Each provider builds the URL + auth headers differently.
 * Add new providers as cases here.
 */
function resolveWsTarget(
  provider: string,
  opts: {
    sandboxId: string;
    port: number;
    remainingPath: string;
    searchParams: URLSearchParams;
    slug?: string;
    serviceKey?: string;
    proxyToken?: string;
  },
): { url: string; headers?: Record<string, string> } {
  switch (provider) {
    case 'justavps':
      if (!opts.slug) break;
      return buildJustavpsWsTarget({
        port: opts.port,
        remainingPath: opts.remainingPath,
        slug: opts.slug,
        serviceKey: opts.serviceKey,
        proxyToken: opts.proxyToken,
      });

    // case 'daytona':
    //   return buildDaytonaWsTarget(...);

    default:
      break;
  }

  return buildLocalDockerWsTarget(opts.sandboxId, opts.port, opts.remainingPath, opts.searchParams, opts.serviceKey);
}

export default {
  port: config.PORT,

  async fetch(req: Request, server: any): Promise<Response | undefined> {
    const host = req.headers.get('host') || '';
    const url = getRequestUrl(req, config.PORT);
    const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

    // ── Subdomain preview routing (primary) ────────────────────────────
    // Matches: p{port}-{sandboxId}.localhost:{serverPort}
    // Only for local_docker mode (Daytona has its own preview URLs).
    const subdomain = !config.isDaytonaEnabled() ? parsePreviewSubdomain(host) : null;

    if (subdomain) {
      const { port, sandboxId } = subdomain;
      const allowLocalPreviewBridge =
        sandboxId === config.SANDBOX_CONTAINER_NAME &&
        isLocalPreviewHost(host);

      // ── CORS preflight must be handled BEFORE auth ──────────────────
      // Browsers send OPTIONS without Authorization headers. If we block
      // the preflight with 401, the browser can never send the actual
      // request that carries the Bearer token to authenticate the subdomain.
      if (req.method === 'OPTIONS') {
        const origin = req.headers.get('Origin') || '';
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || '*',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      // ── Auth: first request validates, then the subdomain is "open" ──
      // Bearer header or cookie on first load proves you're legit,
      // then all subsequent requests (sub-resources, WS, etc.) pass through.
      // This avoids third-party cookie issues in iframes.
      if (!allowLocalPreviewBridge && !isSubdomainAuthenticated(sandboxId, port)) {
        const authHeader = req.headers.get('Authorization');
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const kortixTokenHeader = req.headers.get('X-Kortix-Token');
        const cookieToken = extractCookieToken(req);
        // Also accept ?token= query param — browser WebSocket API can't set
        // custom headers, and initial page loads may not have cookies yet.
        const queryToken = url.searchParams.get('token');
        const token = bearerToken || cookieToken || kortixTokenHeader || queryToken;

        if (!token || !(await validatePreviewToken(token, sandboxId))) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
              'Access-Control-Allow-Credentials': 'true',
            },
          });
        }
        // Auth succeeded — mark this subdomain as authenticated
        markSubdomainAuthenticated(sandboxId, port);
      } else if (allowLocalPreviewBridge) {
        markSubdomainAuthenticated(sandboxId, port);
      }

      // ── WebSocket upgrade via subdomain ──────────────────────────────
      if (isWsUpgrade) {
        const resolved = await resolveProvider(sandboxId).catch(() => null);
        const provider = resolved?.provider ?? 'local_docker';

        const wsTarget = resolveWsTarget(provider, {
          sandboxId,
          port,
          remainingPath: url.pathname,
          searchParams: url.searchParams,
          slug: resolved?.slug,
          serviceKey: resolved?.serviceKey,
          proxyToken: resolved?.proxyToken,
        });

        const success = server.upgrade(req, {
          headers: buildWsUpgradeHeaders(req),
          data: {
            targetUrl: wsTarget.url,
            subprotocol: getRequestedWsProtocol(req),
            upstreamHeaders: {
              ...(wsTarget.headers || {}),
              ...(buildWsUpgradeHeaders(req) || {}),
            },
            upstream: null,
            buffered: [],
            bufferBytes: 0,
            connectTimer: null,
            idleTimer: null,
            closed: false,
          } satisfies WsProxyData,
        });
        if (success) return undefined;
      }

      // ── HTTP/SSE via subdomain — direct proxy, no Hono ───────────────
      const origin = req.headers.get('Origin') || '';
      let body: ArrayBuffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await req.arrayBuffer();
      }

      // NOTE: CORS preflight (OPTIONS) is handled above, before the auth check.

      try {
        const resolved = await resolveProvider(sandboxId).catch(() => null);

        // JustAVPS: route through CF Worker proxy at {port}--{slug}.{domain}
        if (config.isJustAVPSEnabled()) {
          const { sandboxes } = await import('@kortix/db');
          const { db } = await import('./shared/db');
          const { eq, and, ne } = await import('drizzle-orm');
          const [sandbox] = await db
            .select({ provider: sandboxes.provider, config: sandboxes.config, metadata: sandboxes.metadata })
            .from(sandboxes)
            .where(and(eq(sandboxes.externalId, sandboxId), ne(sandboxes.status, 'pooled')))
            .limit(1);

          if (sandbox?.provider === 'justavps') {
            const meta = (sandbox.metadata || {}) as Record<string, unknown>;
            const slug = meta.justavpsSlug as string || '';
            let proxyToken = meta.justavpsProxyToken as string || '';
            const svcKey = (sandbox.config as Record<string, unknown>)?.serviceKey as string || '';
            const proxyDomain = config.JUSTAVPS_PROXY_DOMAIN;
            const cfProxyUrl = `https://${port}--${slug}.${proxyDomain}`;

            // Proactive refresh: if the stored token is missing or near expiry,
            // rotate before sending the request. Dedup'd across concurrent
            // requests for the same sandbox.
            if (isProxyTokenStale(meta)) {
              const refreshed = await refreshSandboxProxyToken(sandboxId, meta);
              if (refreshed) {
                proxyToken = refreshed.token;
                invalidateProviderCache(sandboxId);
              }
            }

            const extra: Record<string, string> = {};
            if (proxyToken) {
              extra['X-Proxy-Token'] = proxyToken;
            }

            const firstResponse = await proxyToSandbox(
              sandboxId, 8000, req.method, url.pathname, url.search,
              req.headers, body, false, origin, cfProxyUrl, svcKey, extra,
            );

            // Rescue path: if the CF Worker rejected the token (401/403), the
            // stored token was stale in a way proactive refresh didn't catch —
            // for example, the sandbox was offline longer than TTL + buffer,
            // or the DB copy diverged from CF KV. Mint fresh and retry once.
            if (
              (firstResponse.status === 401 || firstResponse.status === 403) &&
              proxyToken
            ) {
              console.warn(
                `[subdomain-proxy] CF Worker returned ${firstResponse.status} for ${sandboxId}; refreshing proxy token and retrying once`,
              );
              const refreshed = await refreshSandboxProxyToken(sandboxId, meta);
              if (refreshed && refreshed.token !== proxyToken) {
                invalidateProviderCache(sandboxId);
                return await proxyToSandbox(
                  sandboxId, 8000, req.method, url.pathname, url.search,
                  req.headers, body, false, origin, cfProxyUrl, svcKey,
                  { 'X-Proxy-Token': refreshed.token },
                );
              }
            }

            return firstResponse;
          }
        }

        // Subdomain routing: the subdomain itself encodes which port the
        // client is accessing, so the public base URL has no path prefix.
        // Override the path-based default in proxyToSandbox so static-web's
        // <base href> resolves sub-resources back through the same subdomain
        // (not through `/v1/p/{sandboxId}/{port}/...` which doesn't exist on
        // the subdomain).
        const fwdProto = req.headers.get('x-forwarded-proto') || 'http';
        return await proxyToSandbox(
          sandboxId, port, req.method, url.pathname, url.search,
          req.headers, body, false, origin,
          undefined, resolved?.serviceKey,
          { 'X-Forwarded-Prefix': `${fwdProto}://${host}` },
        );
      } catch (error) {
        console.error(`[subdomain-proxy] Error for ${sandboxId}:${port}${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
        return new Response(JSON.stringify({ error: 'Failed to proxy to sandbox', details: String(error) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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

    // ── Path-based WebSocket proxy ─────────────────────────────────────────
    // Matches: ws://localhost:8008/v1/p/{sandboxId}/{port}/*
    // Used for OpenCode PTY terminals, SSE-over-WS, etc.
    // Must be handled HERE (at Bun server level) because Hono can't do WS upgrades.
    // Each provider resolves the upstream WebSocket URL differently.
    if (isWsUpgrade && !config.isDaytonaEnabled()) {
      const wsPathMatch = url.pathname.match(/^\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/);
      if (wsPathMatch) {
        const wsSandboxId = wsPathMatch[1];
        const wsPort = parseInt(wsPathMatch[2], 10);
        const wsRemainingPath = wsPathMatch[3] || '/';

        const wsAuthHeader = req.headers.get('Authorization');
        const wsBearerToken = wsAuthHeader?.startsWith('Bearer ') ? wsAuthHeader.slice(7) : null;
        const wsKortixTokenHeader = req.headers.get('X-Kortix-Token');
        const wsCookieToken = extractCookieToken(req);
        const wsQueryToken = url.searchParams.get('token');
        const wsToken = wsBearerToken || wsCookieToken || wsKortixTokenHeader || wsQueryToken;

        if (wsToken && (await validatePreviewToken(wsToken, wsSandboxId))) {
          const resolved = await resolveProvider(wsSandboxId).catch(() => null);
          const provider = resolved?.provider ?? 'local_docker';

          const wsTarget = resolveWsTarget(provider, {
            sandboxId: wsSandboxId,
            port: wsPort,
            remainingPath: wsRemainingPath,
            searchParams: url.searchParams,
            slug: resolved?.slug,
            serviceKey: resolved?.serviceKey,
            proxyToken: resolved?.proxyToken,
          });

          const success = server.upgrade(req, {
            headers: buildWsUpgradeHeaders(req),
            data: {
              targetUrl: wsTarget.url,
              subprotocol: getRequestedWsProtocol(req),
              upstreamHeaders: {
                ...(wsTarget.headers || {}),
                ...(buildWsUpgradeHeaders(req) || {}),
              },
              upstream: null,
              buffered: [],
              bufferBytes: 0,
              connectTimer: null,
              idleTimer: null,
              closed: false,
            } satisfies WsProxyData,
          });
          if (success) return undefined;
        }
      }
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

      activeWsConnections++;
      resetIdleTimer(ws);

      ws.data.connectTimer = setTimeout(() => {
        if (ws.data.upstream?.readyState === WebSocket.CONNECTING) {
          console.warn(`[preview-proxy] WS upstream connect timeout`);
          try { ws.data.upstream.close(); } catch {}
          try { ws.close(1011, 'upstream connect timeout'); } catch {}
        }
      }, WS_CONNECT_TIMEOUT_MS);

      try {
        const upstream = ws.data.subprotocol
          ? new WebSocket(ws.data.targetUrl, ws.data.subprotocol, { headers: ws.data.upstreamHeaders || {} } as any)
          : new WebSocket(ws.data.targetUrl, { headers: ws.data.upstreamHeaders || {} } as any);
        ws.data.upstream = upstream;

        upstream.addEventListener('open', () => {
          if (ws.data.connectTimer) { clearTimeout(ws.data.connectTimer); ws.data.connectTimer = null; }
          for (const msg of ws.data.buffered) {
            upstream.send(msg);
          }
          ws.data.buffered = [];
          ws.data.bufferBytes = 0;
        });

        upstream.addEventListener('message', (e: MessageEvent) => {
          resetIdleTimer(ws);
          try { ws.send(e.data); } catch {
            try { upstream.close(); } catch {}
          }
        });

        upstream.addEventListener('close', () => {
          if (!ws.data.closed) {
            try { ws.close(); } catch {}
          }
        });

        upstream.addEventListener('error', () => {
          if (!ws.data.closed) {
            try { ws.close(1011, 'upstream error'); } catch {}
          }
        });
      } catch (err) {
        console.error(`[preview-proxy] WS connect failed:`, err);
        try { ws.close(1011, 'upstream connection failed'); } catch {}
      }
    },

    message(ws: { data: any; close: (code?: number, reason?: string) => void }, message: string | Buffer) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onMessage(ws.data.tunnelId, message);
        return;
      }

      resetIdleTimer(ws);
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (upstream && upstream.readyState === WebSocket.CONNECTING) {
        const size = typeof message === 'string' ? message.length : (message as Buffer).byteLength;
        if (ws.data.bufferBytes + size > WS_BUFFER_MAX_BYTES) {
          console.warn(`[preview-proxy] WS buffer overflow, closing`);
          try { ws.close(1011, 'buffer overflow'); } catch {}
          return;
        }
        ws.data.buffered.push(message);
        ws.data.bufferBytes += size;
      }
    },

    close(ws: { data: any }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onClose(ws.data.tunnelId);
        return;
      }

      activeWsConnections--;
      ws.data.closed = true;
      clearWsTimers(ws.data);
      try { ws.data.upstream?.close(); } catch {}
      ws.data.upstream = null;
      ws.data.buffered = [];
      ws.data.bufferBytes = 0;
    },
  },
};
 
