import { Hono } from 'hono'
import type { ServerWebSocket } from 'bun'

import type { Config } from './config'
import { logger } from './logger'
import type { Opencode } from './opencode'
import { isRepoMaterialized } from './git'
import { createHealthRouter, type SandboxBootState } from './routes/health'
import { createRefreshRouter } from './routes/refresh'
import { createAbortRouter } from './routes/abort'
import { createEnvRouter } from './routes/env'
import { createGitRouter } from './routes/git'
import { createPortProxyRouter } from './routes/port-proxy'
import { createFilesRouter } from './routes/files'
import { createFindRouter } from './routes/find'
import { createPresentationRouter } from './routes/presentation'
import webProxyRouter from './routes/web-proxy'
import type { ProjectEnvStore } from './project-env'
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

const PTY_WS_PATH_RE = /^\/pty\/[^/]+\/connect\/?$/
const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

// Bound on waiting for opencode to respond to a proxied request. Applied only
// to the wait for the response to arrive (headers), never to a streaming body
// already in flight — an SSE stream like /global/event legitimately stays open
// for the life of the session, so aborting on a fixed wall clock would sever
// healthy long-lived connections. A wedged opencode process (hung event loop,
// deadlock) otherwise leaves this `fetch` unresolved forever: the daemon's own
// `/kortix/health` stays green throughout (it never touches opencode), so
// nothing else catches it, and the browser just sees the request hang until
// something upstream (ALB/ingress) eventually resets the connection — which
// surfaces as a confusing "blocked by CORS" error with no real diagnostic
// value. Failing fast here instead gives a clean 502 that apps/api's own
// retry+auto-wake loop can act on immediately.
const UPSTREAM_RESPONSE_TIMEOUT_MS = 10_000

type OpencodeWsData = {
  type: 'opencode-pty'
  url: string
  headers?: Record<string, string>
  upstream?: WebSocket
  ready?: boolean
  queue?: Array<string | Buffer | ArrayBuffer | Uint8Array>
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sanitizeCloseCode(code: number | undefined): number {
  if (typeof code !== 'number') return 1000
  if (code === 1000) return 1000
  if (code >= 3000 && code <= 4999) return code
  return 1000
}

function redactWsUrl(input: string): string {
  try {
    const url = new URL(input)
    if (url.searchParams.has('ticket')) url.searchParams.set('ticket', '[redacted]')
    return url.toString()
  } catch {
    return input.replace(/([?&]ticket=)[^&]+/i, '$1[redacted]')
  }
}

async function prepareOpencodePtyWsUpgrade(
  req: Request,
  cfg: Config,
  opencode: Opencode,
  bootState: SandboxBootState,
): Promise<
  | { ok: true; data: OpencodeWsData }
  | { ok: false; response: Response }
> {
  const url = new URL(req.url)
  if (!PTY_WS_PATH_RE.test(url.pathname)) {
    return { ok: false, response: jsonError(404, { error: 'unsupported websocket path' }) }
  }

  if (!cfg.sandboxToken) {
    logger.warn('[proxy] rejecting websocket: KORTIX_TOKEN not configured')
    return {
      ok: false,
      response: jsonError(503, { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }),
    }
  }

  const header = req.headers.get(KORTIX_USER_CONTEXT_HEADER) ?? url.searchParams.get(KORTIX_USER_CONTEXT_QUERY_PARAM)
  const auth = verifyKortixUserContext(header, cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn('[proxy] reject websocket', { reason: auth.reason, path: url.pathname })
    return { ok: false, response: jsonError(401, { error: 'unauthorized', reason: auth.reason }) }
  }

  if (bootState.repoMaterializationError) {
    return {
      ok: false,
      response: jsonError(503, {
        error: 'sandbox runtime not ready',
        reason: 'repo_materialization_failed',
        message: bootState.repoMaterializationError,
      }),
    }
  }

  if (cfg.autoClone && !(await isRepoMaterialized(cfg.projectTarget))) {
    return {
      ok: false,
      response: jsonError(503, { error: 'sandbox runtime not ready', reason: 'repo_not_materialized' }),
    }
  }

  if (bootState.initialOpenCodeSessionError) {
    return {
      ok: false,
      response: jsonError(503, {
        error: 'sandbox runtime not ready',
        reason: 'initial_opencode_session_failed',
        message: bootState.initialOpenCodeSessionError,
      }),
    }
  }

  if (bootState.initialOpenCodeSessionRequired && !bootState.initialOpenCodeSessionId) {
    return {
      ok: false,
      response: jsonError(503, {
        error: 'sandbox runtime not ready',
        reason: 'initial_opencode_session_pending',
      }),
    }
  }

  if (opencode.getState() !== 'ok') {
    return {
      ok: false,
      response: jsonError(503, { error: 'opencode not ready', opencode: opencode.getState() }),
    }
  }

  url.searchParams.delete(KORTIX_USER_CONTEXT_QUERY_PARAM)

  const upstreamUrl = new URL(`${opencode.getInternalUrl()}${url.pathname}${url.search}`.replace(/^http:/i, 'ws:'))
  const httpUrl = new URL(upstreamUrl.toString().replace(/^ws:/i, 'http:'))
  const headers = { 'x-opencode-directory': cfg.projectTarget || cfg.workspace }

  try {
    const tokenUrl = new URL(httpUrl.toString())
    tokenUrl.pathname = tokenUrl.pathname.replace(/\/connect\/?$/, '/connect-token')
    tokenUrl.search = ''
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'x-opencode-ticket': '1',
      },
      signal: AbortSignal.timeout(UPSTREAM_RESPONSE_TIMEOUT_MS),
    })
    if (tokenRes.ok) {
      const body = await tokenRes.json().catch(() => null) as { ticket?: unknown } | null
      if (typeof body?.ticket === 'string' && body.ticket.length > 0) {
        upstreamUrl.searchParams.set('ticket', body.ticket)
        if (!upstreamUrl.searchParams.has('cursor')) upstreamUrl.searchParams.set('cursor', '-1')
      }
    } else if (tokenRes.status !== 404) {
      const detail = (await tokenRes.text().catch(() => '')).slice(0, 200)
      logger.warn('[proxy] opencode pty ticket mint failed; falling back to direct websocket', {
        status: tokenRes.status,
        path: tokenUrl.pathname,
        detail,
      })
    }
  } catch (err) {
    logger.warn('[proxy] opencode pty ticket mint threw; falling back to direct websocket', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    ok: true,
    data: {
      type: 'opencode-pty',
      url: upstreamUrl.toString(),
      headers,
    },
  }
}

export function buildOpencodeApp(
  cfg: Config,
  opencode: Opencode,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
): Hono {
  const app = new Hono()

  // The daemon owns a small Kortix-namespaced control surface. Everything else is
  // pure passthrough to opencode. Mount at both `/health` and `/health/` so
  // a trailing slash doesn't fall through to the reverse proxy.
  // Health bypasses auth — it's how the cloud probes liveness mid-boot.
  const kortixRouter = new Hono()
  const healthRouter = createHealthRouter(cfg, opencode, bootTime, bootState, staticWebPort)
  const refreshRouter = createRefreshRouter(cfg, opencode)
  const abortRouter = createAbortRouter(cfg)
  const envRouter = projectEnv ? createEnvRouter(cfg, opencode, projectEnv) : null
  // NOTE: /kortix/git is currently unused by the product (the agent commits +
  // opens change requests from a chat prompt). Kept as a host-driven primitive.
  const gitRouter = createGitRouter(cfg)
  kortixRouter.route('/health', healthRouter)
  kortixRouter.route('/health/', healthRouter)
  kortixRouter.route('/refresh', refreshRouter)
  kortixRouter.route('/refresh/', refreshRouter)
  kortixRouter.route('/abort', abortRouter)
  kortixRouter.route('/abort/', abortRouter)
  kortixRouter.route('/git', gitRouter)
  kortixRouter.route('/git/', gitRouter)
  if (envRouter) {
    kortixRouter.route('/env', envRouter)
    kortixRouter.route('/env/', envRouter)
  }

  app.route('/kortix', kortixRouter)

  // Auth gate for everything except /kortix/*. Spec §3.5: the daemon MUST
  // validate X-Kortix-User-Context (HMAC-signed by the API with KORTIX_TOKEN)
  // before forwarding to opencode. Without a configured token the daemon is
  // an open door; we log loudly at boot and reject all proxied requests until
  // KORTIX_TOKEN is provided.
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/kortix/')) return next()

    if (!cfg.sandboxToken) {
      logger.warn('[proxy] rejecting request: KORTIX_TOKEN not configured')
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const header = c.req.header(KORTIX_USER_CONTEXT_HEADER)
    const result = verifyKortixUserContext(header, cfg.sandboxToken)
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

  // /file/* — the daemon owns the ENTIRE file API: reads (GET / list,
  // /content, /raw, /status) and writes (upload, delete, mkdir, rename). We do
  // NOT forward file reads to OpenCode — its /file/content base64-inlines
  // images only and returns empty content for every other binary, breaking
  // Office-doc/PDF previews and downloads. Serving off disk here is correct for
  // all types. (/project/current + /global/health still fall through.)
  app.route('/file', createFilesRouter(cfg))

  // /find/* — daemon-served search (file-by-name + ripgrep text search), also
  // formerly forwarded to OpenCode.
  app.route('/find', createFindRouter(cfg))

  // /presentation/* — on-demand PDF/PPTX export for the slide-deck viewer's
  // download buttons. Runs the conversion in the background and answers each
  // poll fast (202 while generating, 200 + the file when ready) so it never
  // trips the apps/api preview-proxy's per-attempt timeout. See the router doc.
  app.route('/presentation', createPresentationRouter(cfg))

  // Reverse-proxy catch-all → OpenCode. Stream both directions so SSE works.
  // If opencode hasn't bound its port yet (state !== 'ok') we 503 instead of
  // attempting a fetch — surfaces the situation clearly to the client and
  // prevents noisy ECONNREFUSED loops.
  app.all('*', async (c) => {
    if (bootState.repoMaterializationError) {
      return c.json(
        {
          error: 'sandbox runtime not ready',
          reason: 'repo_materialization_failed',
          message: bootState.repoMaterializationError,
        },
        503,
      )
    }

    if (cfg.autoClone && !(await isRepoMaterialized(cfg.projectTarget))) {
      return c.json(
        {
          error: 'sandbox runtime not ready',
          reason: 'repo_not_materialized',
        },
        503,
      )
    }

    if (bootState.initialOpenCodeSessionError) {
      return c.json(
        {
          error: 'sandbox runtime not ready',
          reason: 'initial_opencode_session_failed',
          message: bootState.initialOpenCodeSessionError,
        },
        503,
      )
    }

    if (bootState.initialOpenCodeSessionRequired && !bootState.initialOpenCodeSessionId) {
      return c.json(
        {
          error: 'sandbox runtime not ready',
          reason: 'initial_opencode_session_pending',
        },
        503,
      )
    }

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

    // Bound only the wait for opencode's response (headers) — not the abort
    // controller's whole lifetime — so we can free-run a stream once it starts.
    // Clearing the timer right after `fetch` resolves means the controller can
    // never fire again, so a long-lived SSE body already in flight (e.g.
    // /global/event) is never cut off mid-stream.
    const controller = new AbortController()
    const responseTimer = setTimeout(() => controller.abort(), UPSTREAM_RESPONSE_TIMEOUT_MS)
    try {
      const fetchInit: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        body: hasBody ? (c.req.raw.body as ReadableStream | null) : undefined,
        // duplex: 'half' is required by undici when piping a ReadableStream body;
        // Bun accepts the extra key too. Not in lib.dom RequestInit yet.
        duplex: 'half',
        signal: controller.signal,
      }
      const upstream = await fetch(upstreamUrl, fetchInit)
      clearTimeout(responseTimer)

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
      clearTimeout(responseTimer)
      const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      if (timedOut) {
        logger.error('[proxy] upstream fetch timed out — opencode unresponsive', {
          path: url.pathname,
          timeoutMs: UPSTREAM_RESPONSE_TIMEOUT_MS,
        })
      } else {
        logger.error('[proxy] upstream fetch failed', err)
      }
      return c.json({ error: 'upstream unreachable', details: (err as Error).message }, 502)
    }
  })

  return app
}

export type ProxyServer = {
  stop(): Promise<void>
  port: number
  // Rebuild the control surface with a new Config. A warm snapshot seed boots
  // with seed-time credentials and only learns its forked session cfg after
  // restore; without this the proxy auth gate + routers keep the seed cfg.
  reload(next: Config): void
}

export function startProxy(
  cfg: Config,
  opencode: Opencode,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
): ProxyServer {
  // Mutable so restore-time reload() can hot-swap the handler in place; the
  // indirection below re-reads `app` per request, so reassigning it is enough.
  let currentCfg = cfg
  let app = buildOpencodeApp(cfg, opencode, bootTime, bootState, projectEnv, staticWebPort)

  const server = Bun.serve<OpencodeWsData>({
    port: cfg.servicePort,
    hostname: '0.0.0.0',
    // SSE streams from OpenCode can be long-lived with no traffic; default 10s
    // kills them. 255s matches kortix-master's tuned value.
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      if (isWsUpgrade && PTY_WS_PATH_RE.test(url.pathname)) {
        const prep = await prepareOpencodePtyWsUpgrade(req, currentCfg, opencode, bootState)
        if (!prep.ok) return prep.response
        const upgraded = srv.upgrade(req, { data: prep.data })
        if (upgraded) return undefined
        return jsonError(500, { error: 'websocket upgrade failed' })
      }
      return app.fetch(req, srv)
    },
    websocket: {
      open(ws: ServerWebSocket<OpencodeWsData>) {
        const state = ws.data
        if (state.type !== 'opencode-pty') {
          try { ws.close(1011, 'unsupported websocket upgrade') } catch {}
          return
        }

        state.queue = []
        state.ready = false

        let upstream: WebSocket
        try {
          upstream = new WebSocket(state.url, { headers: state.headers ?? {} } as any)
        } catch (err) {
          logger.warn('[proxy] opencode websocket connect threw', {
            err: err instanceof Error ? err.message : String(err),
            url: redactWsUrl(state.url),
          })
          try { ws.close(1011, 'upstream connect failed') } catch {}
          return
        }

        upstream.binaryType = 'arraybuffer'
        state.upstream = upstream

        upstream.onopen = () => {
          state.ready = true
          const queued = state.queue ?? []
          state.queue = []
          for (const msg of queued) {
            try { upstream.send(msg as any) } catch {}
          }
        }

        upstream.onmessage = (event: MessageEvent) => {
          try { ws.send(event.data as any) } catch {}
        }

        upstream.onclose = (event: CloseEvent) => {
          if (!state.ready || event.code !== 1000 || event.reason) {
            logger.warn('[proxy] opencode websocket closed', {
              code: event.code,
              reason: event.reason,
              ready: state.ready,
              url: redactWsUrl(state.url),
            })
          }
          try { ws.close(sanitizeCloseCode(event.code), (event.reason || '').slice(0, 120)) } catch {}
        }

        upstream.onerror = () => {
          logger.warn('[proxy] opencode websocket error', { url: redactWsUrl(state.url) })
          try { ws.close(1011, 'upstream error') } catch {}
        }
      },
      message(ws: ServerWebSocket<OpencodeWsData>, message: string | Buffer) {
        const state = ws.data
        const upstream = state.upstream
        if (state.ready && upstream && upstream.readyState === WebSocket.OPEN) {
          try { upstream.send(message as any) } catch {}
        } else {
          (state.queue ??= []).push(message)
        }
      },
      close(ws: ServerWebSocket<OpencodeWsData>) {
        try { ws.data.upstream?.close() } catch {}
      },
    },
  })

  const boundPort = server.port ?? cfg.servicePort
  logger.info('[proxy] listening', { port: boundPort, hostname: '0.0.0.0' })

  return {
    port: boundPort,
    reload(next: Config) {
      currentCfg = next
      app = buildOpencodeApp(next, opencode, bootTime, bootState, projectEnv, staticWebPort)
      logger.info('[proxy] reloaded with session config', { projectId: next.projectId })
    },
    async stop() {
      server.stop(true)
    },
  }
}
