/**
 * Public URL Share Endpoints — /v1/p/share
 *
 * Proxies to the sandbox's /kortix/share endpoints so the frontend can create,
 * list, and revoke share links without talking to the sandbox directly.
 *
 * Provider-neutral: every session resolves through the session sandbox
 * proxy table before this route talks to the sandbox daemon.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { resolveProvider } from '../index'
import { combinedAuth } from '../../middleware/auth'
import { canAccessPreviewSandbox } from '../../shared/preview-ownership'
import { makeOpenApiApp, json, errors, auth } from '../../openapi'

const shareApp = makeOpenApiApp()
type ResolvedProvider = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>

// Share results are whatever the sandbox daemon's /kortix/share endpoint
// returns (opaque), or our own { error } envelope — model permissively.
const ShareResultSchema = z.record(z.string(), z.any()).openapi('ShareResult')

function buildSandboxShareBaseUrl(resolved: ResolvedProvider): string | null {
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

async function ensureShareAccess(c: Context, sandboxId: string): Promise<Response | null> {
  const userId = c.get('userId') as string | undefined
  const accountId = c.get('accountId') as string | undefined

  if (userId && await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId })) {
    return null
  }
  if (accountId && await canAccessPreviewSandbox({ previewSandboxId: sandboxId, accountId })) {
    return null
  }
  return c.json({ error: 'Not authorized to access this sandbox' }, 403)
}

shareApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['preview'],
    summary: 'Create a public share link for a sandbox port',
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              sandbox_id: z.string(),
              port: z.number().int().min(1).max(65535),
              ttl: z.string().optional(),
              label: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(ShareResultSchema, 'Share link (proxied from the sandbox daemon)'),
      ...errors(400, 401, 403, 404, 502),
    },
  }),
  // Manual body parsing retained: the original contract returns a custom
  // { error: 'Invalid JSON body' } / field-specific 400s before any access
  // check, and proxies the sandbox's opaque status code through unchanged.
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

    const accessError = await ensureShareAccess(c, sandbox_id)
    if (accessError) return accessError

    const target = await resolveShareTarget(sandbox_id)
    if ('error' in target) {
      return c.json({ error: target.error }, target.status as any)
    }

    const queryParams = new URLSearchParams()
    if (ttl) queryParams.set('ttl', ttl)
    if (label) queryParams.set('label', label)
    const qs = queryParams.toString() ? `?${queryParams.toString()}` : ''
    const sandboxUrl = `${target.sandboxShareBaseUrl}/${port}${qs}`

    try {
      const resp = await fetch(sandboxUrl, {
        headers: buildSandboxHeaders(target.resolved),
        signal: AbortSignal.timeout(10_000),
      })

      const result = await parseJsonResponse(resp)
      return c.json(result, resp.status as any)
    } catch (err) {
      console.error('[share] create share link failed:', err)
      return c.json({ error: 'Failed to create share link' }, 502)
    }
  },
)

shareApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['preview'],
    summary: 'List public share links for a sandbox',
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      query: z.object({ sandbox_id: z.string() }),
    },
    responses: {
      200: json(ShareResultSchema, 'Share links (proxied from the sandbox daemon)'),
      ...errors(400, 401, 403, 404, 502),
    },
  }),
  // Manual query read kept — original returns a custom 400 envelope and proxies
  // the sandbox's status code through.
  async (c) => {
    const sandbox_id = c.req.query('sandbox_id')
    if (!sandbox_id || typeof sandbox_id !== 'string') {
      return c.json({ error: 'sandbox_id is required (string)' }, 400)
    }

    const accessError = await ensureShareAccess(c, sandbox_id)
    if (accessError) return accessError

    const target = await resolveShareTarget(sandbox_id)
    if ('error' in target) {
      return c.json({ error: target.error }, target.status as any)
    }

    try {
      const resp = await fetch(target.sandboxShareBaseUrl, {
        headers: buildSandboxHeaders(target.resolved),
        signal: AbortSignal.timeout(10_000),
      })
      const result = await parseJsonResponse(resp)
      return c.json(result, resp.status as any)
    } catch (err) {
      console.error('[share] load share links failed:', err)
      return c.json({ error: 'Failed to load share links' }, 502)
    }
  },
)

shareApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{token}',
    tags: ['preview'],
    summary: 'Revoke a public share link',
    ...auth,
    middleware: [combinedAuth] as const,
    request: {
      params: z.object({ token: z.string() }),
      query: z.object({ sandbox_id: z.string() }),
    },
    responses: {
      200: json(ShareResultSchema, 'Revocation result (proxied from the sandbox daemon)'),
      ...errors(400, 401, 403, 404, 502),
    },
  }),
  // Manual param/query read kept — original returns field-specific 400 envelopes
  // and proxies the sandbox's status code through.
  async (c) => {
    const sandbox_id = c.req.query('sandbox_id')
    if (!sandbox_id || typeof sandbox_id !== 'string') {
      return c.json({ error: 'sandbox_id is required (string)' }, 400)
    }

    const token = c.req.param('token')
    if (!token) {
      return c.json({ error: 'token is required' }, 400)
    }

    const accessError = await ensureShareAccess(c, sandbox_id)
    if (accessError) return accessError

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
      console.error('[share] revoke share link failed:', err)
      return c.json({ error: 'Failed to revoke share link' }, 502)
    }
  },
)

export { shareApp }
