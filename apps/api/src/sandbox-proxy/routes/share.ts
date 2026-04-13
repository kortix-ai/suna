/**
 * Public URL Share Endpoints — /v1/p/share
 *
 * Proxies to the sandbox's /kortix/share endpoints so the frontend can create,
 * list, and revoke share links without talking to the sandbox directly.
 *
 * Routes:
 * - POST   /v1/p/share        body: { sandbox_id, port, ttl?, label? }
 * - GET    /v1/p/share        query: sandbox_id
 * - DELETE /v1/p/share/:token query: sandbox_id
 *
 * Auth: combinedAuth (Supabase JWT, kortix_ token, or cookie).
 */

import { Hono } from 'hono'
import { config } from '../../config'
import { resolveProvider } from '../index'
import { combinedAuth } from '../../middleware/auth'
import { ensureLocalSandboxPublicBase } from '../../platform/services/local-public-base'

const shareApp = new Hono()
type ResolvedProvider = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>

function buildSharedUrl(baseUrl: string, token: string): string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  base.pathname = `/s/${token}/`
  return base.toString()
}

function buildSandboxShareBaseUrl(resolved: ResolvedProvider): string | null {
  if (resolved.provider === 'justavps' && resolved.slug && resolved.proxyToken) {
    const domain = config.JUSTAVPS_PROXY_DOMAIN
    return `https://8000--${resolved.slug}.${domain}/kortix/share`
  }
  if (resolved.baseUrl) {
    return `${resolved.baseUrl}/kortix/share`
  }
  return null
}

function buildSandboxHeaders(resolved: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = {}
  if (resolved.serviceKey) {
    headers.Authorization = `Bearer ${resolved.serviceKey}`
  }
  if (resolved.proxyToken) {
    headers['X-Proxy-Token'] = resolved.proxyToken
  }
  return headers
}

async function parseJsonResponse(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { error: text.slice(0, 500) }
  }
}

async function resolveShareTarget(sandboxId: string): Promise<{
  resolved: ResolvedProvider
  sandboxShareBaseUrl: string
} | {
  error: string
  status: number
}> {
  const resolved = await resolveProvider(sandboxId)
  if (!resolved) {
    return { error: 'Sandbox not found or not active', status: 404 }
  }

  const sandboxShareBaseUrl = buildSandboxShareBaseUrl(resolved)
  if (!sandboxShareBaseUrl) {
    return { error: 'Cannot reach sandbox', status: 502 }
  }

  return { resolved, sandboxShareBaseUrl }
}

shareApp.post('/',
  combinedAuth,
  async (c) => {
    let body: { sandbox_id: string; port: number; ttl?: string; label?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { sandbox_id, port, ttl, label } = body
    if (!sandbox_id || typeof sandbox_id !== 'string') {
      return c.json({ error: 'sandbox_id is required (string)' }, 400)
    }
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      return c.json({ error: 'port is required (1-65535)' }, 400)
    }

    const target = await resolveShareTarget(sandbox_id)
    if ('error' in target) {
      return c.json({ error: target.error }, target.status as any)
    }

    const queryParams = new URLSearchParams()
    if (ttl) queryParams.set('ttl', ttl)
    if (label) queryParams.set('label', label)
    const qs = queryParams.toString() ? `?${queryParams.toString()}` : ''
    const sandboxUrl = `${target.sandboxShareBaseUrl}/${port}${qs}`

    // Forward the request to the sandbox
    try {
      let localPublicBaseUrl: string | null = null
      if (target.resolved.provider === 'local_docker') {
        localPublicBaseUrl = await ensureLocalSandboxPublicBase(target.resolved.baseUrl, target.resolved.serviceKey)
      }

      const resp = await fetch(sandboxUrl, {
        headers: buildSandboxHeaders(target.resolved),
        signal: AbortSignal.timeout(10_000),
      })

      const result = await parseJsonResponse(resp)

      if (!resp.ok) {
        return c.json(result, resp.status as any)
      }

      if (target.resolved.provider === 'local_docker') {
        if (typeof result.token === 'string' && localPublicBaseUrl) {
          result.url = buildSharedUrl(localPublicBaseUrl, result.token)
        }
      }

      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: 'Failed to create share link', details: msg }, 502)
    }
  },
)

shareApp.get('/', combinedAuth, async (c) => {
  const sandbox_id = c.req.query('sandbox_id')
  if (!sandbox_id || typeof sandbox_id !== 'string') {
    return c.json({ error: 'sandbox_id is required (string)' }, 400)
  }

  const target = await resolveShareTarget(sandbox_id)
  if ('error' in target) {
    return c.json({ error: target.error }, target.status as any)
  }

  try {
    if (target.resolved.provider === 'local_docker') {
      await ensureLocalSandboxPublicBase(target.resolved.baseUrl, target.resolved.serviceKey)
    }

    const resp = await fetch(target.sandboxShareBaseUrl, {
      headers: buildSandboxHeaders(target.resolved),
      signal: AbortSignal.timeout(10_000),
    })
    const result = await parseJsonResponse(resp)
    return c.json(result, resp.status as any)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Failed to load share links', details: msg }, 502)
  }
})

shareApp.delete('/:token', combinedAuth, async (c) => {
  const sandbox_id = c.req.query('sandbox_id')
  if (!sandbox_id || typeof sandbox_id !== 'string') {
    return c.json({ error: 'sandbox_id is required (string)' }, 400)
  }

  const token = c.req.param('token')
  if (!token) {
    return c.json({ error: 'token is required' }, 400)
  }

  const target = await resolveShareTarget(sandbox_id)
  if ('error' in target) {
    return c.json({ error: target.error }, target.status as any)
  }

  try {
    const resp = await fetch(`${target.sandboxShareBaseUrl}/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: buildSandboxHeaders(target.resolved),
      signal: AbortSignal.timeout(10_000),
    })
    const result = await parseJsonResponse(resp)
    return c.json(result, resp.status as any)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Failed to revoke share link', details: msg }, 502)
  }
})

export { shareApp }
