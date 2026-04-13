/**
 * Public URL sharing — /kortix/share/:port
 *
 * Creates a short-lived, publicly-accessible URL for a port inside the sandbox.
 * Each share gets a unique token with a configurable TTL. The URL routes through
 * /s/{token}/* on kortix-master, which validates the token before proxying.
 *
 * Defaults:
 *   TTL: 1 hour  |  Min: 5 minutes  |  Max: 7 days
 *
 * Query params:
 *   ?ttl=30m    — custom TTL (supports: 30s, 15m, 2h, 1d, 1h30m, or plain seconds)
 *   ?label=demo — optional human-readable label
 *
 * Also supports:
 *   GET  /kortix/share            — list all active shares
 *   DELETE /kortix/share/:token   — revoke a specific share
 *
 * Auth: inherits from global middleware (localhost bypass for agent, service key for external).
 */

import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'
import { getEnv } from '../../opencode/tools/lib/get-env.js'
import { config } from '../config'
import {
  createShare,
  listShares,
  revokeShare,
  parseTTL,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  formatTTL,
} from '../services/share-store'

// ── Response schemas ────────────────────────────────────────────────────────

const ShareResponse = z.object({
  url: z.string().describe('Public URL to access the service'),
  port: z.number().describe('Container port'),
  token: z.string().describe('Share token (used in URL path)'),
  expiresAt: z.string().describe('ISO 8601 expiry timestamp'),
  ttl: z.string().describe('Human-readable TTL'),
  label: z.string().optional().describe('Optional label'),
  hint: z.string().optional().describe('Guidance for the agent'),
})

const ShareErrorResponse = z.object({
  error: z.string(),
  port: z.number().optional(),
})

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the public base URL that reaches port 8000 (kortix-master) from outside.
 * This is where /s/{token}/* lives.
 */
export function getMasterPublicBaseUrl(): string {
  const envMode = process.env.ENV_MODE || 'local'
  const slug = process.env.JUSTAVPS_SLUG || ''
  const proxyToken = process.env.JUSTAVPS_PROXY_TOKEN || ''
  const proxyDomain = process.env.JUSTAVPS_PROXY_DOMAIN || 'kortix.cloud'
  const explicitPublicBase = getEnv('PUBLIC_BASE_URL') || process.env.PUBLIC_BASE_URL || ''

  // Explicit public base wins. This is the authoritative external URL injected
  // by the platform and already includes the correct host/query params for the
  // current sandbox. Using cloud fallbacks before this breaks webhook URLs by
  // generating authenticated /v1/p/... links instead of public proxy URLs.
  if (explicitPublicBase) {
    return explicitPublicBase.replace(/\/+$/, '')
  }

  // Cloud: CF Worker URL for port 8000
  if (envMode === 'cloud' && slug && proxyToken) {
    return `https://8000--${slug}.${proxyDomain}?__proxy_token=${proxyToken}`
  }

  // Cloud without JustAVPS: via kortix-api proxy
  const sandboxId = process.env.SANDBOX_ID || ''
  const kortixApiUrl = (process.env.KORTIX_API_URL || '').replace(/\/v1\/router\/?$/, '')
  if (envMode === 'cloud' && sandboxId && kortixApiUrl) {
    return `${kortixApiUrl}/v1/p/${sandboxId}/8000`
  }

  // Local: host port mapping for port 8000, or direct
  const hostPort = config.PORT_MAP['8000']
  if (hostPort) {
    return `http://localhost:${hostPort}`
  }

  return `http://localhost:${config.PORT}`
}

/**
 * Build the share URL: {masterBaseUrl}/s/{token}/
 * For cloud mode with __proxy_token in query string, the URL constructor merges them.
 */
function buildShareUrl(token: string): string {
  const base = getMasterPublicBaseUrl()
  try {
    const url = new URL(`/s/${token}/`, base)
    // Preserve __proxy_token from the base URL
    const baseUrl = new URL(base)
    for (const [k, v] of baseUrl.searchParams) {
      url.searchParams.set(k, v)
    }
    return url.toString()
  } catch {
    // Fallback if URL parsing fails
    const sep = base.includes('?') ? '&' : '?'
    return `${base}/s/${token}/${sep}`
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

const shareRouter = new Hono()

// GET /kortix/share/:port — create a new share
shareRouter.get('/:port{[0-9]+}',
  describeRoute({
    tags: ['System'],
    summary: 'Create a public share URL for a sandbox port',
    description:
      'Creates a short-lived, publicly-accessible URL for a service running on the specified port. ' +
      'Default TTL is 1 hour. Supports ?ttl=30m, ?ttl=2h, ?ttl=1d etc. Max 7 days. ' +
      'For persistent access, deploy the service to a CDN or hosting platform instead.',
    responses: {
      200: { description: 'Share created', content: { 'application/json': { schema: resolver(ShareResponse) } } },
      400: { description: 'Invalid port or TTL', content: { 'application/json': { schema: resolver(ShareErrorResponse) } } },
    },
  }),
  (c) => {
    const portStr = c.req.param('port')
    const port = parseInt(portStr, 10)

    if (isNaN(port) || port < 1 || port > 65535) {
      return c.json({ error: 'Invalid port number', port: 0 }, 400)
    }

    // Parse optional TTL
    const ttlParam = c.req.query('ttl')
    let ttlMs = DEFAULT_TTL_MS

    if (ttlParam) {
      const parsed = parseTTL(ttlParam)
      if (parsed === null) {
        return c.json({
          error: `Invalid TTL format: "${ttlParam}". Use: 30s, 15m, 2h, 1d, or plain seconds.`,
          port,
        }, 400)
      }
      if (parsed < MIN_TTL_MS) {
        return c.json({
          error: `TTL too short: minimum is ${formatTTL(MIN_TTL_MS)}`,
          port,
        }, 400)
      }
      if (parsed > MAX_TTL_MS) {
        return c.json({
          error: `TTL too long: maximum is ${formatTTL(MAX_TTL_MS)}. For persistent access, deploy to a CDN or hosting platform.`,
          port,
        }, 400)
      }
      ttlMs = parsed
    }

    const label = c.req.query('label')
    const entry = createShare(port, ttlMs, label || undefined)
    const url = buildShareUrl(entry.token)

    const response: Record<string, unknown> = {
      url,
      port,
      token: entry.token,
      expiresAt: entry.expiresAt,
      ttl: formatTTL(ttlMs),
    }

    if (entry.label) response.label = entry.label

    // Add guidance for long TTLs
    if (ttlMs > 24 * 60 * 60 * 1000) {
      response.hint = 'For persistent public access, consider deploying to a CDN or hosting platform instead of long-lived shares.'
    }

    return c.json(response)
  },
)

// GET /kortix/share — list all active shares
shareRouter.get('/',
  describeRoute({
    tags: ['System'],
    summary: 'List all active share URLs',
    responses: {
      200: { description: 'Active shares' },
    },
  }),
  (c) => {
    const portFilter = c.req.query('port')
    const port = portFilter ? parseInt(portFilter, 10) : undefined
    const active = listShares(port)

    return c.json({
      shares: active.map(entry => ({
        url: buildShareUrl(entry.token),
        port: entry.port,
        token: entry.token,
        expiresAt: entry.expiresAt,
        label: entry.label,
      })),
      count: active.length,
    })
  },
)

// DELETE /kortix/share/:token — revoke a share
shareRouter.delete('/:token',
  describeRoute({
    tags: ['System'],
    summary: 'Revoke a share URL',
    responses: {
      200: { description: 'Share revoked' },
      404: { description: 'Share not found' },
    },
  }),
  (c) => {
    const token = c.req.param('token')
    const revoked = revokeShare(token)

    if (!revoked) {
      return c.json({ error: 'Share not found or already expired' }, 404)
    }

    return c.json({ ok: true, revoked: token })
  },
)

export default shareRouter
