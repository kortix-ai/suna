import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'
import { config } from '../config'
import { ErrorResponse } from '../schemas/common'

const pipedreamRouter = new Hono()

/**
 * Derive the v1 API base URL from KORTIX_API_URL.
 * KORTIX_API_URL may contain a path suffix (e.g. "/v1/router") used by other
 * subsystems. We only need the origin (scheme + host + port) for direct API calls.
 */
function getApiV1(): string {
  try {
    return new URL(config.KORTIX_API_URL).origin + '/v1'
  } catch {
    // Fallback: strip any path and append /v1
    return config.KORTIX_API_URL.replace(/\/+$/, '').replace(/\/v1\/.*$/, '') + '/v1'
  }
}

/**
 * Build X-Pipedream-* headers from sandbox env vars.
 * These let the sandbox send its own Pipedream credentials to kortix-api,
 * which uses them instead of (or as fallback for) its global config.
 */
function getPipedreamHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  if (process.env.PIPEDREAM_CLIENT_ID) headers['x-pipedream-client-id'] = process.env.PIPEDREAM_CLIENT_ID
  if (process.env.PIPEDREAM_CLIENT_SECRET) headers['x-pipedream-client-secret'] = process.env.PIPEDREAM_CLIENT_SECRET
  if (process.env.PIPEDREAM_PROJECT_ID) headers['x-pipedream-project-id'] = process.env.PIPEDREAM_PROJECT_ID
  if (process.env.PIPEDREAM_ENVIRONMENT) headers['x-pipedream-environment'] = process.env.PIPEDREAM_ENVIRONMENT
  return headers
}

// NOTE: Per-route auth middleware removed — global auth in index.ts now
// always enforces INTERNAL_SERVICE_KEY on all routes (auto-generated if not set).

/**
 * Guard: ensure KORTIX_TOKEN is available before proxying to kortix-api.
 * The bootstrap-env service restores it at boot if needed, so this should
 * only fire if something went seriously wrong.
 */
pipedreamRouter.use('*', async (c, next) => {
  if (!config.KORTIX_TOKEN) {
    console.error('[Pipedream] KORTIX_TOKEN is not set — cannot authenticate to kortix-api.')
    return c.json({
      error: 'Pipedream unavailable: KORTIX_TOKEN is not configured. Restart the sandbox.',
    }, 503)
  }

  // Local PIPEDREAM_* env vars are optional overrides.
  // If present, getPipedreamHeaders() sends them as X-Pipedream-* headers.
  // If absent, kortix-api uses its own defaults (env or per-account DB creds).
  await next()
})

/**
 * POST /api/pipedream/token
 * Proxy to kortix-api: POST /v1/pipedream/token
 * Used by agent tools to fetch OAuth tokens for third-party APIs.
 */
pipedreamRouter.post('/token',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'Get OAuth token',
    description: 'Proxies to kortix-api to fetch an OAuth token for a connected third-party integration. Used by agent tools.',
    responses: {
      200: { description: 'OAuth token response', content: { 'application/json': { schema: resolver(z.object({ token: z.string(), expires_at: z.string().optional() }).passthrough()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json()
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      c.header('Cache-Control', 'no-store')
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Token fetch error:', err)
      return c.json({ error: 'Failed to fetch integration token' }, 502)
    }
  },
)

pipedreamRouter.post('/proxy',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'Proxy API request',
    description: 'Proxies an authenticated HTTP request to a third-party API on behalf of the user. OAuth credentials are injected automatically.',
    responses: {
      200: { description: 'Proxied API response', content: { 'application/json': { schema: resolver(z.any()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json()
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      c.header('Cache-Control', 'no-store')
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Proxy request error:', err)
      return c.json({ error: 'Failed to proxy integration request' }, 502)
    }
  },
)

pipedreamRouter.get('/list',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'List connected Pipedream integrations',
    description: 'Returns the list of third-party apps that have been connected via Pipedream OAuth for this sandbox.',
    responses: {
      200: { description: 'Integration list', content: { 'application/json': { schema: resolver(z.any()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/list`, {
        headers: {
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] List error:', err)
      return c.json({ error: 'Failed to list integrations' }, 502)
    }
  },
)

pipedreamRouter.get('/actions',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'List available actions',
    description: 'Returns available actions for a connected integration app. Optionally filter by app slug and search query.',
    responses: {
      200: { description: 'Actions list', content: { 'application/json': { schema: resolver(z.any()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const appSlug = c.req.query('app')
      const query = c.req.query('q')
      const limit = c.req.query('limit')

      const params = new URLSearchParams()
      if (appSlug) params.set('app', appSlug)
      if (query) params.set('q', query)
      if (limit) params.set('limit', limit)

      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/actions?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Actions list error:', err)
      return c.json({ error: 'Failed to list actions' }, 502)
    }
  },
)

pipedreamRouter.post('/connect',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'Connect an app',
    description: 'Initiates OAuth connection for a third-party app. Returns a URL the user must visit to authorize the app.',
    responses: {
      200: { description: 'Connect URL', content: { 'application/json': { schema: resolver(z.object({ url: z.string() }).passthrough()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json()
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Connect error:', err)
      return c.json({ error: 'Failed to create connect token' }, 502)
    }
  },
)

pipedreamRouter.get('/search-apps',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'Search available apps',
    description: 'Search for third-party apps available for OAuth connection. Returns app slugs, names, and descriptions.',
    responses: {
      200: { description: 'App search results', content: { 'application/json': { schema: resolver(z.any()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const query = c.req.query('q')
      const limit = c.req.query('limit')

      const params = new URLSearchParams()
      if (query) params.set('q', query)
      if (limit) params.set('limit', limit)

      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/search-apps?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Search apps error:', err)
      return c.json({ error: 'Failed to search apps' }, 502)
    }
  },
)

pipedreamRouter.post('/run-action',
  describeRoute({
    tags: ['Pipedream'],
    summary: 'Run an action',
    description: 'Executes a specific action for a connected integration app with the given parameters.',
    responses: {
      200: { description: 'Action result', content: { 'application/json': { schema: resolver(z.any()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      502: { description: 'Upstream error', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json()
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/run-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })

      const data = await res.json()

      if (!res.ok) {
        return c.json(data, res.status as any)
      }

      c.header('Cache-Control', 'no-store')
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Run action error:', err)
      return c.json({ error: 'Failed to run action' }, 502)
    }
  },
)

// ─── Trigger management proxy routes ──────────────────────────────────────────

pipedreamRouter.get('/triggers/available', async (c) => {
    try {
      const appSlug = c.req.query('app')
      const query = c.req.query('q')
      const limit = c.req.query('limit')

      const params = new URLSearchParams()
      if (appSlug) params.set('app', appSlug)
      if (query) params.set('q', query)
      if (limit) params.set('limit', limit)

      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/triggers/available?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()
      if (!res.ok) return c.json(data, res.status as any)
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] List available triggers error:', err)
      return c.json({ error: 'Failed to list available triggers' }, 502)
    }
  },
)

pipedreamRouter.post('/triggers/deploy', async (c) => {
    try {
      const body = await c.req.json()
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/triggers/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })

      const data = await res.json()
      if (!res.ok) return c.json(data, res.status as any)

      c.header('Cache-Control', 'no-store')
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Deploy trigger error:', err)
      return c.json({ error: 'Failed to deploy trigger' }, 502)
    }
  },
)

pipedreamRouter.get('/triggers/deployed', async (c) => {
    try {
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/triggers/deployed`, {
        headers: {
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()
      if (!res.ok) return c.json(data, res.status as any)
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] List deployed triggers error:', err)
      return c.json({ error: 'Failed to list deployed triggers' }, 502)
    }
  },
)

pipedreamRouter.delete('/triggers/deployed/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/triggers/deployed/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()
      if (!res.ok) return c.json(data, res.status as any)
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Delete trigger error:', err)
      return c.json({ error: 'Failed to delete trigger' }, 502)
    }
  },
)

pipedreamRouter.put('/triggers/deployed/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()
      const apiUrl = getApiV1()
      const res = await fetch(`${apiUrl}/pipedream/triggers/deployed/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.KORTIX_TOKEN}`,
          ...getPipedreamHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })

      const data = await res.json()
      if (!res.ok) return c.json(data, res.status as any)
      return c.json(data)
    } catch (err) {
      console.error('[Pipedream] Update trigger error:', err)
      return c.json({ error: 'Failed to update trigger' }, 502)
    }
  },
)

// ─── Credential management proxy ──────────────────────────────────────────────

pipedreamRouter.put('/credentials', async (c) => {
  try {
    const body = await c.req.json()
    const apiUrl = getApiV1()
    const res = await fetch(`${apiUrl}/pipedream/credentials`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.KORTIX_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (!res.ok) return c.json(data, res.status as any)
    return c.json(data)
  } catch (err) {
    console.error('[Pipedream] Save credentials error:', err)
    return c.json({ error: 'Failed to save credentials' }, 502)
  }
})

pipedreamRouter.get('/credentials', async (c) => {
  try {
    const apiUrl = getApiV1()
    const res = await fetch(`${apiUrl}/pipedream/credentials`, {
      headers: { Authorization: `Bearer ${config.KORTIX_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (!res.ok) return c.json(data, res.status as any)
    return c.json(data)
  } catch (err) {
    console.error('[Pipedream] Get credentials error:', err)
    return c.json({ error: 'Failed to get credentials' }, 502)
  }
})

// ─── Boot-time credential push ───────────────────────────────────────────────
// Push sandbox Pipedream env vars to the API DB so the frontend can use them.

export async function pushPipedreamCredsToApi(): Promise<void> {
  const { PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID, PIPEDREAM_ENVIRONMENT } = process.env
  if (!PIPEDREAM_CLIENT_ID || !PIPEDREAM_CLIENT_SECRET || !PIPEDREAM_PROJECT_ID) {
    console.log('[Pipedream] No local creds to push to API')
    return
  }
  if (!config.KORTIX_TOKEN || !config.KORTIX_API_URL) {
    console.log('[Pipedream] No KORTIX_TOKEN/API_URL — skipping cred push')
    return
  }

  try {
    const apiUrl = getApiV1()
    const res = await fetch(`${apiUrl}/pipedream/credentials`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.KORTIX_TOKEN}`,
      },
      body: JSON.stringify({
        client_id: PIPEDREAM_CLIENT_ID,
        client_secret: PIPEDREAM_CLIENT_SECRET,
        project_id: PIPEDREAM_PROJECT_ID,
        environment: PIPEDREAM_ENVIRONMENT || 'production',
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) {
      console.log('[Pipedream] Credentials pushed to API successfully')
    } else {
      const body = await res.text()
      console.warn(`[Pipedream] Failed to push creds to API (${res.status}): ${body}`)
    }
  } catch (err) {
    console.warn('[Pipedream] Failed to push creds to API:', err)
  }
}

// ─── Connector auto-create ────────────────────────────────────────────────────
// Called by the API when a new Pipedream OAuth connection is saved.
// Inserts into the connectors SQLite table.

async function upsertPipedreamConnector(app: string, appName?: string): Promise<string> {
  const name = (appName || app).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '')
  const { Database } = await import('bun:sqlite')
  const { mkdirSync } = await import('node:fs')
  const { randomUUID } = await import('node:crypto')

  const root = process.env.KORTIX_WORKSPACE || '/workspace'
  mkdirSync(`${root}/.kortix`, { recursive: true })
  const db = new Database(`${root}/.kortix/kortix.db`)
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000")
  db.exec(`CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, source TEXT,
    pipedream_slug TEXT, env_keys TEXT, notes TEXT, auto_generated INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)

  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO connectors (id, name, description, source, pipedream_slug, notes, auto_generated, created_at, updated_at)
    VALUES (?, ?, ?, 'pipedream', ?, ?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      source = 'pipedream', pipedream_slug = excluded.pipedream_slug,
      auto_generated = 1, updated_at = excluded.updated_at
  `).run(randomUUID(), name, appName || app, app, `Connected via Pipedream OAuth`, now, now)
  db.close()
  return name
}

pipedreamRouter.post('/connector-sync', async (c) => {
  try {
    const { app, app_name } = await c.req.json() as { app: string; app_name?: string }
    if (!app) return c.json({ error: 'app is required' }, 400)
    const name = await upsertPipedreamConnector(app, app_name)
    console.log(`[Pipedream] Auto-created connector: ${name}`)
    return c.json({ success: true, name })
  } catch (err) {
    console.error('[Pipedream] Connector sync error:', err)
    return c.json({ error: 'Failed to create connector' }, 500)
  }
})

// ─── Boot-time connector reconciliation ──────────────────────────────────────
// Self-heals sandboxes that missed the fire-and-forget connector-sync call from
// the API — e.g. sandbox was booting, network blipped, or this sandbox was
// created after the user OAuth'd the connector. Fetches the account's current
// Pipedream integrations from kortix-api and upserts each into kortix.db.

export async function syncExistingConnectorsFromApi(): Promise<void> {
  if (!config.KORTIX_TOKEN || !config.KORTIX_API_URL) {
    console.log('[Pipedream] Connector boot-sync: no KORTIX_TOKEN/API_URL — skipping')
    return
  }
  try {
    const apiUrl = getApiV1()
    const res = await fetch(`${apiUrl}/pipedream/connections`, {
      headers: {
        Authorization: `Bearer ${config.KORTIX_TOKEN}`,
        ...getPipedreamHeaders(),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[Pipedream] Connector boot-sync: GET /connections returned ${res.status}`)
      return
    }
    const data = await res.json() as { connections?: Array<{ app: string; appName?: string; app_name?: string }> }
    const rows = data.connections || []
    if (rows.length === 0) {
      console.log('[Pipedream] Connector boot-sync: no connections to reconcile')
      return
    }
    let synced = 0
    for (const row of rows) {
      try {
        const name = await upsertPipedreamConnector(row.app, row.appName || row.app_name)
        synced++
        console.log(`[Pipedream] Connector boot-sync upserted: ${name}`)
      } catch (err) {
        console.warn(`[Pipedream] Connector boot-sync failed for ${row.app}:`, err)
      }
    }
    console.log(`[Pipedream] Connector boot-sync complete: ${synced}/${rows.length} reconciled`)
  } catch (err) {
    console.warn('[Pipedream] Connector boot-sync error:', err)
  }
}

export default pipedreamRouter
