import { timingSafeEqual, createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from 'fs'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { describeRoute, resolver, generateSpecs } from 'hono-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { buildMergedSpec } from './services/spec-merger'
import { proxyToOpenCode } from './services/proxy'
import { SecretStore } from './services/secret-store'
import { syncAuthToSecrets, startWatcher as startAuthWatcher } from './services/auth-sync'
import { kortixUserContextMiddleware } from './services/kortix-user-middleware'
// REMOVED: opencode-hotreload watcher — it auto-disposed the OpenCode instance on
// ANY .opencode/ file change, killing all active agent sessions mid-operation.
// Dispose is now handled explicitly by:
//   1. Marketplace installs (frontend calls client.instance.dispose() after ocx add)
//   2. Skill CRUD (skills-api.ts calls client.instance.dispose() after mutations)
//   3. Agent tool (instance_dispose tool for manual config reload)
import envRouter from './routes/env'
import lssRouter from './routes/lss'
import proxyRouter from './routes/proxy'
import webProxyRouter from './routes/web-proxy'
import { updateRoutes as updateRouter } from './routes/update'
import deployRouter from './routes/deploy'
import servicesRouter from './routes/services'
import pipedreamRouter, { pushPipedreamCredsToApi } from './routes/pipedream'
import connectorsRouter from './routes/connectors'
import suggestionsRouter from './routes/suggestions'
import coreRouter from './routes/core'
import reloadRouter from './routes/reload'
import triggersRouter from './routes/triggers'
import shareRouter from './routes/share'
import shareProxyRouter from './routes/share-proxy'
import marketplaceRouter from './routes/marketplace'
import preferencesRouter from './routes/preferences'
import projectsRouter from './routes/projects'
import { tasksRouter } from './routes/tasks'
import { ticketsRouter, ticketProjectsRouter } from './routes/tickets'
import milestonesRouter from './routes/milestones'
import credentialsRouter from './routes/credentials'
import { serviceManager } from './services/service-manager'
import { config } from './config'
import { loadBootstrapEnv, normalizeBootstrapAuthAliases, saveBootstrapEnv } from './services/bootstrap-env'
import { HealthResponse, PortsResponse } from './schemas/common'

// ─── Crash protection ────────────────────────────────────────────────────────
// Prevent unhandled errors from silently killing the process or leaving it
// in a broken state. Log and continue.
process.on('uncaughtException', (err) => {
  console.error('[Kortix Master] UNCAUGHT EXCEPTION:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Kortix Master] UNHANDLED REJECTION:', reason)
})

const app = new Hono()

// ─── Bootstrap: restore core env vars if missing from process.env ───────────
// Must run BEFORE SecretStore because KORTIX_TOKEN is the encryption key.
loadBootstrapEnv()
normalizeBootstrapAuthAliases()

// Initialize secret store and load ENV variables
const secretStore = new SecretStore()
await secretStore.loadIntoProcessEnv()

// Initialize share store (load persisted shares, start prune timer)
import { initShareStore } from './services/share-store'
initShareStore()

import { runUpgradeMigrations } from './services/upgrade'
void runUpgradeMigrations().catch((err) => {
  console.warn('[kortix-master] upgrade migrations failed:', err)
})

// ─── Guarantee core auth vars in s6 env dir ──────────────────────────────────
// These are injected as Docker env vars at container creation but never written
// to the s6 env directory. Tools use getEnv() which falls back to reading
// /run/s6/container_environment/{KEY} — so we must write them there on boot
// to ensure they're always available regardless of how the process was started.
{
  const S6_ENV_DIR = process.env.S6_ENV_DIR || '/run/s6/container_environment'
  const CORE_VARS = ['KORTIX_TOKEN', 'KORTIX_YOLO_API_KEY', 'KORTIX_YOLO_URL', 'KORTIX_API_URL', 'INTERNAL_SERVICE_KEY', 'TUNNEL_TOKEN'] as const
  let synced = 0
  for (const key of CORE_VARS) {
    // Use injected env var, but fall back to a sane default for KORTIX_API_URL
    // so OpenCode's {env:KORTIX_API_URL} substitution always produces a valid URL.
    let val: string | undefined = process.env[key]
    if (!val && key === 'KORTIX_API_URL') {
      val = 'http://localhost:8008'
    }
    if (!val && key === 'KORTIX_YOLO_API_KEY') {
      val = process.env.KORTIX_TOKEN
    }
    if (!val && key === 'KORTIX_YOLO_URL') {
      val = 'https://api-yolo.kortix.com/v1'
    }
    // Ensure defaulted values are in process.env so saveBootstrapEnv() persists them
    // and downstream code (YOLO client, OpenCode config) can read them.
    if (val && !process.env[key]) {
      process.env[key] = val
    }
    if (val) {
      try {
        if (!existsSync(S6_ENV_DIR)) mkdirSync(S6_ENV_DIR, { recursive: true })
        const targetPath = `${S6_ENV_DIR}/${key}`
        let existing: string | null = null
        try {
          existing = readFileSync(targetPath, 'utf-8')
        } catch {}

        if (existing !== val) {
          await Bun.write(targetPath, val)
          synced++
        }
      } catch (err) {
        console.warn(`[Kortix Master] Failed to write ${key} to s6 env dir:`, err)
      }
    }
  }
  if (synced > 0) {
    console.log(`[Kortix Master] Synced ${synced} core env var(s) to s6 env dir`)
  }
  // Persist core vars so they survive across restarts even if Docker env is lost
  saveBootstrapEnv()
}

const authSyncDisabled = process.env.KORTIX_DISABLE_AUTH_SYNC === 'true'

// Two-way sync: OpenCode auth.json ↔ SecretStore (provider API keys)
if (!authSyncDisabled) {
  await syncAuthToSecrets(secretStore).catch(err =>
    console.error('[Kortix Master] auth-sync boot error:', err)
  )
  // File watcher: auto-sync when auth.json changes at runtime
  startAuthWatcher(secretStore)
}

// REMOVED: startHotReload() — see comment at top of file for rationale.

// Updates are Docker image-based — no crash recovery needed

if (process.env.KORTIX_DISABLE_CORE_SUPERVISOR !== 'true') {
  void serviceManager.start().catch(err =>
    console.error('[Kortix Master] service manager start error:', err)
  )
}

// Cron scheduling + webhook routing handled by unified triggers plugin.
// TriggerManager starts cron jobs from .kortix/triggers.yaml + DB on boot.

// Global middleware
app.use('*', logger())

// CORS: restrict to allowed origins. Defaults to localhost-only for security.
// CORS_ALLOWED_ORIGINS can add extra origins (comma-separated).
const defaultCorsOrigins = [
  'http://localhost:3000', 'http://127.0.0.1:3000',   // Frontend (local)
  'http://localhost:8008', 'http://127.0.0.1:8008',   // kortix-api (local)
  'http://localhost:14000', 'http://127.0.0.1:14000', // Direct sandbox (dev)
]
const extraCorsOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : []
const corsOrigins = [...new Set([...defaultCorsOrigins, ...extraCorsOrigins])]
app.use('*', cors({ origin: corsOrigins }))

// ─── Identity from preview proxy ─────────────────────────────────────────────
// Parses the signed `X-Kortix-User-Context` header the Kortix API preview
// proxy attaches to every authenticated user request. Attaches the parsed
// context to `c.get('kortixUser')` for downstream route handlers. Purely
// additive — missing/invalid header is treated as "no user identity" and
// the existing service-key bearer auth remains the hard access gate.
app.use('*', kortixUserContextMiddleware())

// ─── Timing-safe token comparison ─────────────────────────────────────────────
// Hash both values so timingSafeEqual always compares equal-length buffers,
// regardless of token length. Prevents timing side-channel attacks.
function verifyServiceKey(candidate: string): boolean {
  const expected = config.INTERNAL_SERVICE_KEY
  if (!candidate || !expected) return false
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

// ─── Localhost detection ─────────────────────────────────────────────────────
// Requests originating from inside the container (localhost/loopback) skip auth.
// This allows tools, scripts, and curl inside the sandbox to call the master
// without needing INTERNAL_SERVICE_KEY. External callers (kortix-api, frontend
// proxy) still must provide the key.
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

function isLocalRequest(c: any): boolean {
  const addr = c.env?.remoteAddr
  return !!addr && LOOPBACK_ADDRS.has(addr)
}

// ─── Global auth ─────────────────────────────────────────────────────────────
// Protects ALL routes with bearer token or ?token= query param.
// INTERNAL_SERVICE_KEY is always present (auto-generated if not provided).
// Localhost requests (from inside the sandbox) bypass auth entirely.
app.use('*', async (c, next) => {
  // Skip health endpoint — Docker health probes need unauthenticated access
  const pathname = new URL(c.req.url).pathname
  if (pathname === '/kortix/health') return next()
  // Skip docs endpoints — API docs should be accessible without auth
  if (pathname === '/docs' || pathname === '/docs/openapi.json') return next()
  // [channels v2] Channel webhooks now use /hooks/telegram/<id> and /hooks/slack/<id>
  // which are already covered by the /hooks/* bypass below.
  // Skip auth for Pipedream event delivery — Pipedream POSTs events to
  // /events/pipedream/:listenerId. The listener ID acts as a secret token
  // (UUID, not guessable). Events are forwarded to the triggers webhook server.
  if (pathname.startsWith('/events/pipedream/')) return next()
  // Skip auth for user-defined webhook triggers at /hooks/* — external callers
  // authenticate via the X-Kortix-Trigger-Secret header (per-trigger secret).
  if (pathname.startsWith('/hooks/')) return next()
  // Skip auth for share proxy at /s/{token}/* — the share token IS the auth.
  // Token validity + TTL is checked by the share-proxy route handler.
  if (pathname.startsWith('/s/')) return next()

  // Skip auth for requests from inside the sandbox (localhost/loopback)
  if (isLocalRequest(c)) return next()

  const authHeader = c.req.header('Authorization')
  let token: string | null = null

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  }

  if (!token) {
    token = c.req.query('token') || null
  }

  if (!token || !verifyServiceKey(token)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return next()
})

// ─── Runtime readiness tracking ──────────────────────────────────────────────
let openCodeReady = false
let openCodeLastCheck = 0
const OPENCODE_CHECK_INTERVAL = 5_000 // recheck every 5s when not ready

function inspectOpencodeDb(path: string | null) {
  if (!path || !existsSync(path)) return { sessionCount: null, latestSessionUpdate: null }
  let db: Database | null = null
  try {
    db = new Database(path, { readonly: true })
    const row = db.query('SELECT COUNT(*) as count, MAX(time_updated) as latest FROM session').get() as { count?: number; latest?: number | null } | null
    return {
      sessionCount: typeof row?.count === 'number' ? row.count : 0,
      latestSessionUpdate: typeof row?.latest === 'number' ? row.latest : 0,
    }
  } catch {
    return { sessionCount: null, latestSessionUpdate: null }
  } finally {
    if (db) db.close()
  }
}

function inspectOpencodeState() {
  const storageBase = process.env.OPENCODE_STORAGE_BASE || null
  const shadowBase = process.env.OPENCODE_SHADOW_STORAGE_BASE || null
  const persistentRoot = process.env.KORTIX_PERSISTENT_ROOT || null
  const live = inspectOpencodeDb(storageBase ? `${storageBase}/opencode.db` : null)
  const shadow = inspectOpencodeDb(shadowBase ? `${shadowBase}/opencode.db` : null)
  const persistentMode = storageBase === '/persistent/opencode' && persistentRoot === '/persistent'
  const opencodeLegacyLinked = (() => {
    try {
      return lstatSync('/workspace/.local/share/opencode').isSymbolicLink()
        && readlinkSync('/workspace/.local/share/opencode') === '/persistent/opencode'
    } catch {
      return false
    }
  })()
  const opencodeStateMismatch = typeof shadow.sessionCount === 'number'
    && typeof live.sessionCount === 'number'
    && (shadow.sessionCount > live.sessionCount
      || (shadow.sessionCount === live.sessionCount
        && (shadow.latestSessionUpdate ?? 0) > (live.latestSessionUpdate ?? 0)))

  return {
    opencodeStorageBase: storageBase,
    persistentRoot,
    persistentMode,
    opencodeLegacyLinked,
    opencodeStateGuardAvailable: existsSync('/usr/local/bin/kortix-opencode-state'),
    opencodeSessionCount: live.sessionCount,
    opencodeShadowSessionCount: shadow.sessionCount,
    opencodeStateMismatch,
  }
}

async function checkOpenCodeReady(): Promise<boolean> {
  const now = Date.now()
  if (now - openCodeLastCheck < OPENCODE_CHECK_INTERVAL) return openCodeReady
  openCodeLastCheck = now

  if (process.env.KORTIX_LINUX_ISOLATION === 'on') {
    const healthy = await isSupervisorReady()
    if (healthy !== openCodeReady) {
      console.log(`[Kortix Master] supervisor ${healthy ? 'ready' : 'unreachable'}`)
    }
    openCodeReady = healthy
    return healthy
  }

  try {
    const res = await fetch(`http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}/session`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (res.ok) {
      if (!openCodeReady) {
        console.log('[Kortix Master] OpenCode is ready')
      }
      openCodeReady = true
      await res.arrayBuffer()
      return true
    }
    await res.arrayBuffer().catch(() => {})
  } catch {}
  if (openCodeReady) {
    console.warn('[Kortix Master] OpenCode is no longer reachable')
  }
  openCodeReady = false
  void serviceManager.requestRecovery('opencode-serve', 'health-check')
  return false
}

async function isSupervisorReady(): Promise<boolean> {
  const socket = process.env.KORTIX_SUPERVISOR_SOCKET || '/run/kortix/supervisor.sock'
  try {
    const res = await fetch('http://supervisor/health', {
      // @ts-ignore Bun supports unix
      unix: socket,
      signal: AbortSignal.timeout(1_500),
    })
    return res.ok
  } catch {
    return false
  }
}

await checkOpenCodeReady()

// ─── API Documentation ──────────────────────────────────────────────────────

// OpenAPI JSON spec endpoint — merges kortix-master + OpenCode specs at runtime
app.get('/docs/openapi.json',
  describeRoute({ hide: true, responses: { 200: { description: 'OpenAPI spec' } } }),
  async (c) => {
    // Generate kortix-master's own spec
    const kortixSpec = await generateSpecs(app)
    // Merge with OpenCode's spec (fetched from localhost, cached 30s)
    const merged = await buildMergedSpec(kortixSpec as any)

    // Use the X-Forwarded-Prefix header injected by the platform proxy to set
    // the correct server URL for Scalar "Try It". This header contains the full
    // public base URL (e.g. "http://localhost:8008/v1/p/kortix-sandbox/8000").
    // Without it, fall back to the placeholder from spec-merger.
    const forwardedPrefix = c.req.header('x-forwarded-prefix')
    if (forwardedPrefix) {
      return c.json({
        ...merged,
        servers: [{ url: forwardedPrefix, description: 'Current sandbox' }],
      })
    }

    return c.json(merged)
  },
)

// Scalar API Reference UI
app.get('/docs',
  describeRoute({ hide: true, responses: { 200: { description: 'API docs UI' } } }),
  Scalar({
    url: 'docs/openapi.json',
    pageTitle: 'Kortix Sandbox API',
  }),
)

// Health check — includes current sandbox version
// Returns 200 when the agent runtime is reachable, 503 when it's still starting up.
// This ensures Docker/orchestrators treat the container as unhealthy until
// the core API backend (OpenCode) is ready to serve requests.
app.get('/kortix/health',
  describeRoute({
    tags: ['System'],
    summary: 'Health check',
    description: 'Returns sandbox health status, current version, active WebSocket connections, and runtime readiness. Returns 200 when the runtime is reachable, 503 when still starting.',
    responses: {
      200: { description: 'Healthy — runtime is reachable', content: { 'application/json': { schema: resolver(HealthResponse) } } },
      503: { description: 'Starting — runtime is not yet reachable', content: { 'application/json': { schema: resolver(HealthResponse) } } },
    },
  }),
  async (c) => {
    // Version priority: injected SANDBOX_VERSION env var (set at provision from
    // image tag), then baked-in /ephemeral/metadata/.version, then 'unknown'.
    let version = process.env.SANDBOX_VERSION || ''
    if (!version) {
      try {
        const file = Bun.file('/ephemeral/metadata/.version')
        if (await file.exists()) {
          const data = await file.json()
          version = data.version || 'unknown'
        }
      } catch {}
    }
    if (!version) version = 'unknown'
    await checkOpenCodeReady()
    const status = openCodeReady ? 'ok' : 'starting'
    const httpStatus = openCodeReady ? 200 : 503
    return c.json({ status, version, imageVersion: version, activeWs: activeConnections, runtimeReady: openCodeReady, ...inspectOpencodeState() }, httpStatus)
  },
)

// Port mappings — returns container→host port map so the frontend
// can use direct URLs instead of guessing proxy paths.
app.get('/kortix/ports',
  describeRoute({
    tags: ['System'],
    summary: 'Port mappings',
    description: 'Returns the container-port to host-port mapping configured by docker-compose. Used by the frontend to build direct URLs.',
    responses: {
      200: { description: 'Port map', content: { 'application/json': { schema: resolver(PortsResponse) } } },
    },
  }),
  (c) => {
    return c.json({ ports: config.PORT_MAP })
  },
)

// Update check — /kortix/update and /kortix/update/status
app.route('/kortix/update', updateRouter)

// ENV management routes
app.route('/env', envRouter)

// LSS semantic search — /lss/search?q=<query> runs local semantic search
app.route('/lss', lssRouter)

// Dashboard and prompt suggestions
app.route('/sessions', suggestionsRouter)

// Deployment management (feature-flagged)
if (config.KORTIX_DEPLOYMENTS_ENABLED) {
  app.route('/kortix/deploy', deployRouter)
}

// Services — unified "what's running" for the frontend
app.route('/kortix/services', servicesRouter)

// Triggers — unified CRUD for all trigger types (cron, webhook, etc.)
app.route('/kortix/triggers', triggersRouter)
// Legacy compat: /kortix/cron/* → forwards to /kortix/triggers/*
app.route('/kortix/cron', triggersRouter)

// Channels — SQLite-backed channel management (Telegram, Slack)
import { channelsRouter } from './routes/channels'
app.route('/kortix/channels', channelsRouter)

// Core supervisor management
app.route('/kortix/core', coreRouter)

// Full reload — restarts OpenCode instance and optionally all services
app.route('/kortix/reload', reloadRouter)

// Marketplace — skill/component install from registry
app.route('/kortix/marketplace', marketplaceRouter)

// Preferences — default model management
app.route('/kortix/preferences', preferencesRouter)

// Projects + Tasks — Kortix project management (frontend source of truth)
// Mount at both paths — Hono sub-routers don't match trailing slash from parent
app.route('/kortix/projects', projectsRouter)
app.route('/kortix/projects/', projectsRouter)
app.route('/kortix/tasks', tasksRouter)
app.route('/kortix/tasks/', tasksRouter)

// v2 board — tickets, columns, fields, templates, project_agents
// ticketProjectsRouter layers project-scoped config under /kortix/projects/:id/*
// so it's mounted at /kortix/projects after the base projects router (last writer wins
// for path-specific handlers; base projects router has no sub-paths like /columns).
app.route('/kortix/tickets', ticketsRouter)
app.route('/kortix/tickets/', ticketsRouter)
app.route('/kortix/projects', ticketProjectsRouter)
app.route('/kortix/projects/', ticketProjectsRouter)

// Milestones — outcome-level grouping under /kortix/projects/:projectId/milestones
app.route('/kortix/projects', milestonesRouter)
app.route('/kortix/projects/', milestonesRouter)

// Project-scoped credentials under /kortix/projects/:projectId/credentials
app.route('/kortix/projects', credentialsRouter)
app.route('/kortix/projects/', credentialsRouter)

// Public URL sharing — /kortix/share/:port returns the public URL for a sandbox port
app.route('/kortix/share', shareRouter)

import { Database as _ScopeDb } from 'bun:sqlite'
import { getUserScopes } from './services/user-scope-cache'

app.get('/kortix/internal/session-scopes/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  try {
    const workspace =
      process.env.KORTIX_WORKSPACE?.trim() ||
      process.env.OPENCODE_CONFIG_DIR?.replace(/\/opencode\/?$/, '') ||
      '/workspace'
    const dbPath = `${workspace}/.kortix/kortix.db`
    const db = new _ScopeDb(dbPath, { readonly: true })
    try {
      const row = db
        .query('SELECT user_id FROM session_owners WHERE session_id = ? LIMIT 1')
        .get(sessionId) as { user_id?: string } | null
      const userId = row?.user_id ?? null
      if (!userId) {
        return c.json({ success: true, data: { user_id: null, scopes: null } })
      }
      const scopes = getUserScopes(userId)
      return c.json({
        success: true,
        data: {
          user_id: userId,
          scopes: scopes ? Array.from(scopes) : null,
        },
      })
    } finally {
      db.close()
    }
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500)
  }
})

// Connectors — SQLite-backed CRUD
app.route('/kortix/connectors', connectorsRouter)

// Pipedream integration proxy — forwards to kortix-api
app.route('/api/pipedream', pipedreamRouter)

// [channels v2] Channel webhooks — handles /hooks/telegram/<id> and /hooks/slack/<id>
// directly in kortix-master. These are looked up in the channels SQLite DB,
// verified, parsed, and dispatched to OpenCode sessions.
// Must be mounted BEFORE the generic /hooks/* proxy to port 8099.
import channelWebhooksRouter from './routes/channel-webhooks'
app.route('', channelWebhooksRouter)

// Webhook trigger proxy — forwards remaining /hooks/* to the triggers webhook server (port 8099).
// Auth is skipped (see auth middleware) — per-trigger secret via X-Kortix-Trigger-Secret header.
app.all('/hooks/*', async (c) => {
  const pathname = new URL(c.req.url).pathname
  try {
    const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text()
    const headers: Record<string, string> = {
      'Content-Type': c.req.header('content-type') || 'application/json',
    }
    // Forward the trigger secret header
    const secret = c.req.header('x-kortix-trigger-secret') ?? c.req.header('x-kortix-opencode-trigger-secret')
    if (secret) headers['x-kortix-trigger-secret'] = secret

    const res = await fetch(`http://localhost:8099${pathname}`, {
      method: c.req.method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json()
    return c.json(data, res.status as any)
  } catch (err) {
    console.error(`[Kortix Master] Webhook proxy error for ${pathname}:`, err)
    return c.json({ ok: false, error: 'Failed to forward webhook to trigger server' }, 502)
  }
})

// Pipedream event receiver — forwards events from Pipedream to the
// triggers webhook server (port 8099). Auth is skipped for this
// path (see auth middleware above) — the listener ID (UUID) is the secret.
app.post('/events/pipedream/:listenerId', async (c) => {
  const listenerId = c.req.param('listenerId')
  try {
    const body = await c.req.text()
    const res = await fetch(`http://localhost:8099/events/pipedream/${listenerId}`, {
      method: 'POST',
      headers: {
        'Content-Type': c.req.header('content-type') || 'application/json',
        // Forward Pipedream headers that might be useful for verification
        ...(c.req.header('x-pd-delivery-id') ? { 'x-pd-delivery-id': c.req.header('x-pd-delivery-id')! } : {}),
        ...(c.req.header('x-pd-signature') ? { 'x-pd-signature': c.req.header('x-pd-signature')! } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json()
    return c.json(data, res.status as any)
  } catch (err) {
    console.error(`[Kortix Master] Pipedream event forward error for ${listenerId}:`, err)
    return c.json({ ok: false, error: 'Failed to forward event to triggers webhook server' }, 502)
  }
})

// Share proxy — /s/:token/* validates share token + TTL, then proxies to the target port.
// Public route (no auth) — the share token IS the authentication.
app.route('/s', shareProxyRouter)

// Dynamic port proxy — /proxy/:port/* forwards to localhost:{port} inside the sandbox
app.route('/proxy', proxyRouter)

// Web forward proxy — /web-proxy/{scheme}/{host}/{path} fetches any URL from inside the sandbox
app.route('/web-proxy', webProxyRouter)

// File management — direct sandbox filesystem access for downloads, uploads, etc.
// Mounted BEFORE the catch-all OpenCode proxy so it works regardless of OpenCode version.
import filesRouter from './routes/files'
app.route('/file', filesRouter)

// Legacy migration — write old thread data into the OpenCode SQLite database
import legacyMigrateRouter from './routes/legacy-migrate'
app.route('/legacy', legacyMigrateRouter)

// [channels v2] The old channels proxy to port 3456 has been removed.
// Channel CLIs (telegram.ts, slack.ts) are standalone scripts.
// Channel webhooks are handled directly by channel-webhooks.ts (mounted above /hooks/* proxy).

// ─── Per-user session scoping ───────────────────────────────────────────────
// Intercept opencode /session list + create BEFORE the catch-all proxy so we
// can (a) stamp ownership on new sessions and (b) filter the list to sessions
// the caller created. Sessions are strictly per-user — even the sandbox owner
// only sees their own sessions. Service-key traffic (no identity header)
// bypasses filtering so backend workers can still enumerate everything.
import {
  filterVisibleSessions,
  stampSessionOwner,
} from './services/session-ownership'

app.get('/session', async (c) => {
  const upstream = await proxyToOpenCode(c)
  const user = c.get('kortixUser')
  if (!user || upstream.status !== 200) return upstream
  const body = await upstream.json().catch(() => null)
  const list = Array.isArray(body) ? body : body?.data ?? []
  if (!Array.isArray(list)) return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers: upstream.headers,
  })
  const canSeeLegacy =
    user.sandboxRole === 'platform_admin' || user.sandboxRole === 'owner'
  const filtered = filterVisibleSessions(
    list as Array<{ id: string }>,
    user.userId,
    canSeeLegacy,
  )
  const out = Array.isArray(body) ? filtered : { ...body, data: filtered }
  const headers = new Headers(upstream.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(out), { status: 200, headers })
})

app.post('/session', async (c) => {
  const upstream = await proxyToOpenCode(c)
  const user = c.get('kortixUser')
  if (!user || upstream.status >= 400) return upstream

  const raw = await upstream.text()
  try {
    const json = JSON.parse(raw) as { id?: string }
    const sessionId = json?.id
    if (sessionId) stampSessionOwner(sessionId, user.userId)
  } catch {
    // non-JSON body — skip stamping.
  }
  const headers = new Headers(upstream.headers)
  headers.delete('content-length')
  return new Response(raw, { status: upstream.status, headers })
})

app.delete('/session/:id', async (c) => {
  const user = c.get('kortixUser')
  if (user) {
    const sessionId = c.req.param('id')
    const canSeeLegacy =
      user.sandboxRole === 'platform_admin' || user.sandboxRole === 'owner'
    const owned = filterVisibleSessions(
      [{ id: sessionId }],
      user.userId,
      canSeeLegacy,
    ).length > 0
    if (!owned) {
      return new Response(
        JSON.stringify({ error: 'You can only delete your own sessions' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    }
  }
  return proxyToOpenCode(c)
})

// Proxy all other requests to OpenCode
app.all('*',
  describeRoute({ hide: true, responses: { 200: { description: 'Proxied to OpenCode' } } }),
  async (c) => {
    return proxyToOpenCode(c)
  },
)

console.log(`[Kortix Master] Starting on port ${config.PORT}`)

// Push Pipedream creds to API after boot (async, non-blocking)
setTimeout(() => pushPipedreamCredsToApi(), 5_000)
console.log(`[Kortix Master] Proxying to OpenCode at ${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`)
console.log(`[Kortix Master] API docs available at http://localhost:${config.PORT}/docs`)

// ─── Blocked ports (same list as the HTTP proxy router) ──────────────────────
const WS_BLOCKED_PORTS = new Set([config.PORT])

// ─── Connection tracking ─────────────────────────────────────────────────────
let activeConnections = 0

// ─── WebSocket constants ─────────────────────────────────────────────────────
const WS_CONNECT_TIMEOUT_MS = 10_000      // 10s to establish upstream connection
const WS_BUFFER_MAX_BYTES = 1024 * 1024   // 1MB max buffer per connection
const WS_IDLE_TIMEOUT_MS = 5 * 60_000     // 5min idle timeout (no messages)

// ─── WebSocket data attached to each proxied connection ──────────────────────
interface WsProxyData {
  targetPort: number
  targetPath: string
  subprotocol?: string
  upstream: WebSocket | null
  buffered: (string | Buffer | ArrayBuffer)[]
  bufferBytes: number
  connectTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  upstreamHeaders?: Record<string, string>
  closed: boolean
}

function clearWsTimers(data: WsProxyData) {
  if (data.connectTimer) { clearTimeout(data.connectTimer); data.connectTimer = null }
  if (data.idleTimer) { clearTimeout(data.idleTimer); data.idleTimer = null }
}

function resetIdleTimer(ws: { data: WsProxyData; close: (code?: number, reason?: string) => void }) {
  if (ws.data.idleTimer) clearTimeout(ws.data.idleTimer)
  ws.data.idleTimer = setTimeout(() => {
    console.warn(`[Kortix Master] WS idle timeout for port ${ws.data.targetPort}`)
    try { ws.close(1000, 'idle timeout') } catch {}
  }, WS_IDLE_TIMEOUT_MS)
}

function buildWsUpstreamHeaders(req: Request): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  const origin = req.headers.get('origin')
  const userAgent = req.headers.get('user-agent')
  const protocol = req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim()

  if (origin) headers.Origin = origin
  if (userAgent) headers['User-Agent'] = userAgent
  if (protocol) headers['Sec-WebSocket-Protocol'] = protocol

  return Object.keys(headers).length > 0 ? headers : undefined
}

function buildWsUpgradeHeaders(req: Request): Record<string, string> | undefined {
  const protocol = req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim()
  return protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined
}

/**
 * Parse /proxy/:port/* from a URL pathname.
 * Returns { port, path } or null if the path doesn't match.
 */
function parseProxyPath(pathname: string): { port: number; path: string } | null {
  const match = pathname.match(/^\/proxy\/(\d{1,5})(\/.*)?$/)
  if (!match) return null
  const port = parseInt(match[1], 10)
  if (isNaN(port) || port < 1 || port > 65535) return null
  return { port, path: match[2] || '/' }
}

/**
 * Bun server export — handles both HTTP (via Hono) and WebSocket upgrades.
 */
export default {
  port: config.PORT,

  // Raise Bun's idle timeout from the default 10s. SSE connections
  // (e.g. /global/event) can be long-lived with no data flowing —
  // the default kills them, causing the frontend to reconnect in a loop.
  // Per-request override (server.timeout(req, 0)) is also applied for SSE
  // in the proxy, but this global value covers any other long-lived connections.
  idleTimeout: 255, // seconds; per-request SSE override disables it entirely

  fetch(req: Request, server: any): Response | Promise<Response> | undefined {
    // ── Per-request timeout for SSE ─────────────────────────────────────
    // Disable idle timeout entirely for SSE requests so Bun doesn't kill
    // long-lived event streams after the global idleTimeout.
    if ((req.headers.get('accept') || '').includes('text/event-stream')) {
      server.timeout(req, 0)
    }
    // ── WebSocket upgrade for /proxy/:port/* ────────────────────────────
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const url = new URL(req.url)

      // Skip auth for localhost (same-container) WS connections
      const wsRemoteAddr = server.requestIP(req)?.address
      const wsIsLocal = !!wsRemoteAddr && LOOPBACK_ADDRS.has(wsRemoteAddr)

      if (!wsIsLocal) {
        // Validate INTERNAL_SERVICE_KEY for external WS upgrades (header or ?token= query param)
        const authHeader = req.headers.get('Authorization')
        let wsToken: string | null = null
        if (authHeader?.startsWith('Bearer ')) wsToken = authHeader.slice(7)
        if (!wsToken) wsToken = url.searchParams.get('token')
        if (!wsToken || !verifyServiceKey(wsToken)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      const parsed = parseProxyPath(url.pathname)

      if (parsed && !WS_BLOCKED_PORTS.has(parsed.port)) {
        const success = server.upgrade(req, {
          headers: buildWsUpgradeHeaders(req),
          data: {
            targetPort: parsed.port,
            targetPath: parsed.path + url.search,
            subprotocol: req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim() || undefined,
            upstream: null,
            buffered: [],
            bufferBytes: 0,
            connectTimer: null,
            idleTimer: null,
            upstreamHeaders: buildWsUpstreamHeaders(req),
            closed: false,
          } satisfies WsProxyData,
        })
        if (success) return undefined // Bun took over — no HTTP response needed
      }

      // Also handle catch-all WebSocket proxy to OpenCode
      if (!parsed) {
        const success = server.upgrade(req, {
          headers: buildWsUpgradeHeaders(req),
          data: {
            targetPort: config.OPENCODE_PORT,
            targetPath: url.pathname + url.search,
            subprotocol: req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim() || undefined,
            upstream: null,
            buffered: [],
            bufferBytes: 0,
            connectTimer: null,
            idleTimer: null,
            upstreamHeaders: buildWsUpstreamHeaders(req),
            closed: false,
          } satisfies WsProxyData,
        })
        if (success) return undefined
      }
    }

    // ── HTTP / SSE — delegate to Hono ──────────────────────────────────
    // Pass the client IP via env so the auth middleware can detect localhost
    const remoteAddr = server.requestIP(req)?.address
    return app.fetch(req, { remoteAddr })
  },

  websocket: {
    /**
     * Client connected — open an upstream WebSocket to the target service.
     */
    open(ws: { data: WsProxyData; send: (data: any) => void; close: (code?: number, reason?: string) => void }) {
      activeConnections++
      const { targetPort, targetPath, upstreamHeaders } = ws.data
      const upstreamUrl = `ws://127.0.0.1:${targetPort}${targetPath}`

      // Start idle timer
      resetIdleTimer(ws)

      // Connection timeout — if upstream doesn't connect in time, kill it
      ws.data.connectTimer = setTimeout(() => {
        if (ws.data.upstream?.readyState === WebSocket.CONNECTING) {
          console.warn(`[Kortix Master] WS upstream connect timeout for port ${targetPort}`)
          try { ws.data.upstream.close() } catch {}
          try { ws.close(1011, 'upstream connect timeout') } catch {}
        }
      }, WS_CONNECT_TIMEOUT_MS)

      try {
        const upstream = upstreamHeaders
          ? (ws.data.subprotocol
              ? new WebSocket(upstreamUrl, ws.data.subprotocol, { headers: upstreamHeaders } as any)
              : new WebSocket(upstreamUrl, { headers: upstreamHeaders } as any))
          : (ws.data.subprotocol
              ? new WebSocket(upstreamUrl, ws.data.subprotocol)
              : new WebSocket(upstreamUrl))
        ws.data.upstream = upstream

        upstream.addEventListener('open', () => {
          // Clear connect timeout
          if (ws.data.connectTimer) { clearTimeout(ws.data.connectTimer); ws.data.connectTimer = null }

          // Flush any messages buffered while upstream was connecting
          for (const msg of ws.data.buffered) {
            upstream.send(msg)
          }
          ws.data.buffered = []
          ws.data.bufferBytes = 0
        })

        upstream.addEventListener('message', (e: MessageEvent) => {
          resetIdleTimer(ws)
          try { ws.send(e.data) } catch {
            // Client disconnected — close upstream
            try { upstream.close() } catch {}
          }
        })

        upstream.addEventListener('close', (e: CloseEvent) => {
          if (!ws.data.closed) {
            // Propagate close code/reason from upstream to downstream client
            try { ws.close(e.code || 1000, e.reason || '') } catch { /* already closed */ }
          }
        })

        upstream.addEventListener('error', (e: Event) => {
          // Log the actual error for debugging — WS error events don't carry
          // details, but the close that follows will have the code/reason.
          console.warn(`[Kortix Master] WS upstream error for port ${targetPort} (path: ${targetPath})`)
          if (!ws.data.closed) {
            try { ws.close(1011, 'upstream error') } catch { /* already closed */ }
          }
        })
      } catch (err) {
        console.error(`[Kortix Master] WS proxy failed to connect to port ${targetPort}:`, err)
        try { ws.close(1011, 'upstream connection failed') } catch {}
      }
    },

    /**
     * Client sent a message — forward to upstream.
     */
    message(ws: { data: WsProxyData; close: (code?: number, reason?: string) => void }, message: string | Buffer) {
      resetIdleTimer(ws)
      const upstream = ws.data.upstream
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message)
      } else if (upstream && upstream.readyState === WebSocket.CONNECTING) {
        // Buffer until upstream is ready, with size limit
        const size = typeof message === 'string' ? message.length : (message as Buffer).byteLength
        if (ws.data.bufferBytes + size > WS_BUFFER_MAX_BYTES) {
          console.warn(`[Kortix Master] WS buffer overflow for port ${ws.data.targetPort}, closing`)
          try { ws.close(1011, 'buffer overflow') } catch {}
          return
        }
        ws.data.buffered.push(message)
        ws.data.bufferBytes += size
      }
      // If upstream is closed/closing, silently drop
    },

    /**
     * Client disconnected — tear down upstream and all timers.
     */
    close(ws: { data: WsProxyData }) {
      activeConnections--
      ws.data.closed = true
      clearWsTimers(ws.data)
      try { ws.data.upstream?.close() } catch {}
      ws.data.upstream = null
      ws.data.buffered = []
      ws.data.bufferBytes = 0
    },
  },
}
