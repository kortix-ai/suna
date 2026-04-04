/**
 * Public URL Share Endpoint — POST /v1/p/share
 *
 * Proxies to the sandbox's /kortix/share/:port endpoint to create a
 * token-based, time-limited share URL. This lets the frontend or external
 * callers create share links without being inside the sandbox.
 *
 * Body: { sandbox_id, port, ttl? }
 * Auth: combinedAuth (Supabase JWT, kortix_ token, or cookie).
 */

import { Hono } from 'hono'
import { config } from '../../config'
import { resolveProvider } from '../index'
import { combinedAuth } from '../../middleware/auth'

const shareApp = new Hono()

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

    // Resolve the sandbox to find how to reach it
    const resolved = await resolveProvider(sandbox_id)
    if (!resolved) {
      return c.json({ error: 'Sandbox not found or not active' }, 404)
    }

    // Build the URL to the sandbox's /kortix/share/:port endpoint
    let sandboxUrl: string
    const queryParams = new URLSearchParams()
    if (ttl) queryParams.set('ttl', ttl)
    if (label) queryParams.set('label', label)
    const qs = queryParams.toString() ? `?${queryParams.toString()}` : ''

    if (resolved.provider === 'justavps' && resolved.slug && resolved.proxyToken) {
      const domain = config.JUSTAVPS_PROXY_DOMAIN
      sandboxUrl = `https://8000--${resolved.slug}.${domain}/kortix/share/${port}${qs}`
    } else if (resolved.baseUrl) {
      sandboxUrl = `${resolved.baseUrl}/kortix/share/${port}${qs}`
    } else {
      return c.json({ error: 'Cannot reach sandbox' }, 502)
    }

    // Forward the request to the sandbox
    try {
      const headers: Record<string, string> = {}
      if (resolved.serviceKey) {
        headers['Authorization'] = `Bearer ${resolved.serviceKey}`
      }
      if (resolved.proxyToken) {
        headers['X-Proxy-Token'] = resolved.proxyToken
      }

      const resp = await fetch(sandboxUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })

      if (!resp.ok) {
        let errorBody: Record<string, unknown> = { error: `Sandbox returned ${resp.status}` }
        try { errorBody = await resp.json() as Record<string, unknown> } catch { /* non-JSON error */ }
        return c.json(errorBody, resp.status as any)
      }

      const result = await resp.json() as Record<string, unknown>
      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: 'Failed to create share link', details: msg }, 502)
    }
  },
)

export { shareApp }
