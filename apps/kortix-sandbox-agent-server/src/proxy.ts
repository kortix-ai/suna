import { Hono } from 'hono'

import type { Config } from './config'
import { logger } from './logger'
import type { Opencode } from './opencode'
import { createHealthRouter } from './routes/health'
import { createRefreshRouter } from './routes/refresh'
import { createPromptRouter } from './routes/prompt'
import { createPortProxyRouter } from './routes/port-proxy'
import webProxyRouter from './routes/web-proxy'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from './kortix-user-context'

// Headers that must not be forwarded — they're connection-scoped or set by us.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
])

const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection'])

export function buildOpencodeApp(cfg: Config, opencode: Opencode, bootTime: number): Hono {
  const app = new Hono()

  // The daemon owns a small Kortix-namespaced control surface. Everything else is
  // pure passthrough to opencode. Mount at both `/health` and `/health/` so
  // a trailing slash doesn't fall through to the reverse proxy.
  // Health bypasses auth — it's how the cloud probes liveness mid-boot.
  const kortixRouter = new Hono()
  const healthRouter = createHealthRouter(cfg, opencode, bootTime)
  const refreshRouter = createRefreshRouter(cfg, opencode)
  const promptRouter = createPromptRouter(cfg)
  kortixRouter.route('/health', healthRouter)
  kortixRouter.route('/health/', healthRouter)
  kortixRouter.route('/refresh', refreshRouter)
  kortixRouter.route('/refresh/', refreshRouter)
  kortixRouter.route('/prompt', promptRouter)
  kortixRouter.route('/prompt/', promptRouter)

  app.route('/kortix', kortixRouter)

  // Auth gate for everything except /kortix/*. Spec §3.5: the daemon MUST
  // validate X-Kortix-User-Context (HMAC-signed by the API with KORTIX_TOKEN)
  // before forwarding to opencode. Without a configured token the daemon is
  // an open door; we log loudly at boot and reject all proxied requests until
  // KORTIX_TOKEN is provided.
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/kortix/')) return next()

    if (!cfg.kortixToken) {
      logger.warn('[proxy] rejecting request: KORTIX_TOKEN not configured')
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const header = c.req.header(KORTIX_USER_CONTEXT_HEADER)
    const result = verifyKortixUserContext(header, cfg.kortixToken)
    if (!result.ok) {
      logger.warn('[proxy] reject', { reason: result.reason, path })
      return c.json({ error: 'unauthorized', reason: result.reason }, 401)
    }

    return next()
  })

  // /proxy/{port}/* — per-port reverse proxy to anything bound on localhost
  // inside the sandbox (the "internal browser" backend). Carried over from
  // legacy kortix-master so any process the agent starts (e.g. `python -m
  // http.server 8080`) is reachable via /v1/p/{sandboxId}/{port}/* on the API.
  // The agent server's own port is blocked to prevent recursion; opencode's
  // internal port is reachable via the catch-all below, not /proxy.
  const portProxyRouter = createPortProxyRouter({
    blockedPorts: new Set([cfg.servicePort]),
  })
  app.route('/proxy', portProxyRouter)

  // /web-proxy/{scheme}/{host}/{path} — forward proxy that rewrites HTML/CSS
  // so external sites embed cleanly inside the internal browser iframe.
  app.route('/web-proxy', webProxyRouter)

  // Reverse-proxy catch-all → OpenCode. Stream both directions so SSE works.
  // If opencode hasn't bound its port yet (state !== 'ok') we 503 instead of
  // attempting a fetch — surfaces the situation clearly to the client and
  // prevents noisy ECONNREFUSED loops.
  app.all('*', async (c) => {
    if (opencode.getState() !== 'ok') {
      return c.json(
        {
          error: 'opencode not ready',
          opencode: opencode.getState(),
        },
        503,
      )
    }

    const url = new URL(c.req.url)
    const upstreamUrl = `${opencode.getInternalUrl()}${url.pathname}${url.search}`

    const headers = new Headers()
    c.req.raw.headers.forEach((value, key) => {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
    })

    const method = c.req.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD'

    try {
      const fetchInit: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        body: hasBody ? (c.req.raw.body as ReadableStream | null) : undefined,
        // duplex: 'half' is required by undici when piping a ReadableStream body;
        // Bun accepts the extra key too. Not in lib.dom RequestInit yet.
        duplex: 'half',
      }
      const upstream = await fetch(upstreamUrl, fetchInit)

      const respHeaders = new Headers()
      upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value)
      })

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      })
    } catch (err) {
      logger.error('[proxy] upstream fetch failed', err)
      return c.json({ error: 'upstream unreachable', details: (err as Error).message }, 502)
    }
  })

  return app
}

export type ProxyServer = {
  stop(): Promise<void>
  port: number
}

export function startProxy(cfg: Config, opencode: Opencode, bootTime: number): ProxyServer {
  const app = buildOpencodeApp(cfg, opencode, bootTime)

  const server = Bun.serve({
    port: cfg.servicePort,
    hostname: '0.0.0.0',
    // SSE streams from OpenCode can be long-lived with no traffic; default 10s
    // kills them. 255s matches kortix-master's tuned value.
    idleTimeout: 255,
    fetch: app.fetch,
  })

  const boundPort = server.port ?? cfg.servicePort
  logger.info('[proxy] listening', { port: boundPort, hostname: '0.0.0.0' })

  return {
    port: boundPort,
    async stop() {
      server.stop(true)
    },
  }
}
