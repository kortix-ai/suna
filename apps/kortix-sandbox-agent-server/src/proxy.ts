import { Hono } from 'hono'
import type { ServerWebSocket } from 'bun'
import type { Config } from './config'
import type { SandboxBootState } from './boot-state'
import type { HarnessService } from './harness/harness'
import type { ProjectEnvStore } from './project-env'
import type { ResourceMonitor } from './resources'
import { egressShimPort } from './egress-shim'
import { logger } from './logger'
import { registerAgentSwapBlocker } from './runtime-assets'
import { createEnvRpcRouter } from './routes/env-rpc'
import { createGitRouter } from './routes/git'
import { createPortProxyRouter } from './routes/port-proxy'
import { createFilesRouter } from './routes/files'
import { createFindRouter } from './routes/find'
import { createPresentationRouter } from './routes/presentation'
import { createWebProxyRouter } from './routes/web-proxy'
import { createPtyRegistry, createPtyRouter, type PtyAttachHandle, type PtyRegistry } from './routes/pty'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from './kortix-user-context'

// The id segment is optional: connecting with no id (or an id the daemon
// doesn't recognize) still opens a working terminal — see the lookup-or-
// create handling in the `open` websocket handler below.
const KORTIX_PTY_WS_PATH_RE = /^\/kortix\/pty(?:\/([^/]+))?\/connect\/?$/
const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

// One per process: the periodic box telemetry (resources.ts). Started by
// startProxy, read by /kortix/diag. Null in unit tests that build the app only.
let resourceMonitor: ResourceMonitor | null = null

type PtyWsData = {
  // Absent when the client connects without an id — lookup-or-create then
  // mints a brand new pty (see `websocket.open` below).
  ptyId?: string
  handle?: PtyAttachHandle
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// The Kortix-native PTY WS upgrade — independent of runtime/repo readiness
// entirely (it just spawns a shell), unlike the (now removed) runtime-
// proxied path this replaced: a raw terminal works even while the repo is
// still cloning or runtime hasn't come up yet.
function prepareKortixPtyWsUpgrade(
  req: Request,
  cfg: Config,
): { ok: true; data: PtyWsData } | { ok: false; response: Response } {
  const url = new URL(req.url)
  const match = KORTIX_PTY_WS_PATH_RE.exec(url.pathname)
  if (!match) {
    return { ok: false, response: jsonError(404, { error: 'unsupported websocket path' }) }
  }
  // Absent when the client connects with no id segment at all (e.g.
  // `/kortix/pty/connect`) — lookup-or-create mints a fresh pty either way.
  const ptyId = match[1]

  if (!cfg.sandboxToken) {
    logger.warn('[pty] rejecting websocket: KORTIX_TOKEN not configured')
    return {
      ok: false,
      response: jsonError(503, { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }),
    }
  }

  const header = req.headers.get(KORTIX_USER_CONTEXT_HEADER) ?? url.searchParams.get(KORTIX_USER_CONTEXT_QUERY_PARAM)
  const auth = verifyKortixUserContext(header, cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn('[pty] reject websocket', { reason: auth.reason, path: url.pathname })
    return { ok: false, response: jsonError(401, { error: 'unauthorized', reason: auth.reason }) }
  }

  return { ok: true, data: { ptyId } }
}

export function buildDaemonApp(
  cfg: Config,
  harness: HarnessService,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
  ptyRegistry?: PtyRegistry,
  agentEnvFile?: string,
): Hono {
  const app = new Hono()

  const kortixRouter = new Hono()
  const context = {
    cfg,
    bootTime,
    bootState,
    projectEnv,
    staticWebPort,
    agentEnvFile,
    resources: () => resourceMonitor,
  }
  // The harness owns its complete native control surface and response shapes.
  harness.http.mountControlRoutes(kortixRouter, context)
  // NOTE: /kortix/git is currently unused by the product (the agent commits +
  // opens change requests from a chat prompt). Kept as a host-driven primitive.
  const gitRouter = createGitRouter(cfg)
  // /kortix/pty — Kortix's own terminal, independent of runtime entirely
  // (see routes/pty.ts). `ptyRegistry` is always passed by `startProxy`;
  // the parameter is optional only so tests can build the app without one.
  const ptyRouter = createPtyRouter(cfg, ptyRegistry ?? createPtyRegistry(cfg))
  kortixRouter.route('/git', gitRouter)
  kortixRouter.route('/git/', gitRouter)
  kortixRouter.route('/pty', ptyRouter)
  kortixRouter.route('/pty/', ptyRouter)
  // The worker execution environment, one operation per POST.
  // Self-authenticated like /pty (X-Kortix-User-Context signed with this box's
  // KORTIX_TOKEN — the worker holds the same session credential).
  const envRpcRouter = createEnvRpcRouter(cfg)
  kortixRouter.route('/env-rpc', envRpcRouter)
  kortixRouter.route('/env-rpc/', envRpcRouter)

  app.route('/kortix', kortixRouter)
  // Auth gate for everything except /kortix/*. Spec §3.5: the daemon MUST
  // validate X-Kortix-User-Context (HMAC-signed by the API with KORTIX_TOKEN)
  // before forwarding to runtime. Without a configured token the daemon is
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
  // The agent server's own port is blocked to prevent recursion; runtime's
  // internal port is reachable via the catch-all below, not /proxy.
  const portProxyRouter = createPortProxyRouter({
    // The egress shim too. It already refuses a plain-HTTP request with 405
    // (it is CONNECT-only) and its per-host TLS listeners reject an HTTP dial,
    // so this closes a door that is bolted — but the shim is the one listener
    // in the guest whose job is to sit in front of a credential, and "it fails
    // closed today" is a weaker guarantee than "it is not routable".
    blockedPorts: new Set([cfg.servicePort, egressShimPort()]),
  })
  app.route('/proxy', portProxyRouter)

  // /web-proxy/{scheme}/{host}/{path} — forward proxy that rewrites HTML/CSS
  // so external sites embed cleanly inside the internal browser iframe.
  //
  // Blocked loopback ports keep it off our own control plane: reaching the
  // daemon or runtime through here would tunnel past every path-keyed control
  // apps/api applies on the way in (agent authorization, connector gate, run
  // cap, prompt idempotency, secret-grant re-mint).
  app.route(
    '/web-proxy',
    createWebProxyRouter({
      // Include every port the selected harness can use, including standby
      // listeners. Reload must not create an unguarded route to the runtime.
      blockedSelfPorts: new Set([
        cfg.servicePort,
        egressShimPort(),
        ...harness.http.blockedPorts(cfg),
      ]),
    }),
  )

  // The daemon owns file reads and writes directly from the workspace,
  // including binary previews and downloads, independently of the harness.
  app.route('/file', createFilesRouter(cfg))

  // /find/* — daemon-served search (file-by-name + ripgrep text search), also
  // formerly forwarded to runtime.
  app.route('/find', createFindRouter(cfg))

  // /presentation/* — on-demand PDF/PPTX export for the slide-deck viewer's
  // download buttons. Runs the conversion in the background and answers each
  // poll fast (202 while generating, 200 + the file when ready) so it never
  // trips the apps/api preview-proxy's per-attempt timeout. See the router doc.
  app.route('/presentation', createPresentationRouter(cfg))

  harness.http.mountFallback(app, context)

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
  harness: HarnessService,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
): ProxyServer {
  // Mutable so restore-time reload() can hot-swap the handler in place; the
  // indirection below re-reads `app` per request, so reassigning it is enough.
  let currentCfg = cfg
  // Constructed once, outside reload() — pty state must survive a config
  // hot-swap (warm-snapshot restore) exactly like `runtime`/`bootState` do.
  const ptyRegistry = createPtyRegistry(cfg)
  // Box telemetry: a `[resources]` log line every minute and on every
  // runtime state change, `[resources] pressure` when a threshold is crossed.
  resourceMonitor?.stop()
  resourceMonitor = harness.background.start(cfg)
  // A staged daemon update must not exit this process while somebody has a
  // terminal open — the PTY dies with the daemon that spawned it. The registry
  // is the only thing that knows, so it answers the question rather than the
  // updater guessing at it. A busy box just keeps the staging: the supervisor
  // installs it at the next start.
  registerAgentSwapBlocker('pty', () =>
    ptyRegistry.list().some((entry) => entry.status === 'running'),
  )
  let app = buildDaemonApp(cfg, harness, bootTime, bootState, projectEnv, staticWebPort, ptyRegistry)

  const server = Bun.serve<PtyWsData>({
    port: cfg.servicePort,
    hostname: '0.0.0.0',
    // SSE streams from runtime can be long-lived with no traffic; default 10s
    // kills them. idleTimeout DISABLED (0): Bun's max is 255s AND Bun does not
    // reset idleTimeout on server->client stream writes, so a 255s ceiling still
    // killed long-lived low-traffic SSE mid-stream. 0 hands lifetime to the
    // stream itself / a real client disconnect (still aborts req.signal).
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      if (isWsUpgrade && KORTIX_PTY_WS_PATH_RE.test(url.pathname)) {
        const prep = prepareKortixPtyWsUpgrade(req, currentCfg)
        if (!prep.ok) return prep.response
        const upgraded = srv.upgrade(req, { data: prep.data })
        if (upgraded) return undefined
        return jsonError(500, { error: 'websocket upgrade failed' })
      }
      return app.fetch(req, srv)
    },
    websocket: {
      // Lookup-or-create: a normal "open a terminal" must always succeed
      // with a working shell. A requested id that names a running pty
      // reattaches (a genuine reconnect resumes the same shell +
      // scrollback). A missing/unknown/absent id — the daemon restarted
      // and forgot its in-memory registry, a stale id survived a reload, or
      // no id was supplied at all — mints a fresh pty instead of hard-
      // closing with "pty not found". Only a *known-exited* pty (the shell
      // itself ended, e.g. the user typed `exit`) closes without recreating
      // — that's a real end-of-session the client should surface, not
      // silently paper over.
      open(ws: ServerWebSocket<PtyWsData>) {
        const state = ws.data
        const requestedId = state.ptyId
        const result = ptyRegistry.attachOrCreate(requestedId, {
          onData: (chunk) => {
            try { ws.send(chunk) } catch {}
          },
          onExit: (exitCode) => {
            try { ws.close(1000, `pty exited${exitCode === null ? '' : ` (${exitCode})`}`) } catch {}
          },
        })
        if (result.kind === 'exited') {
          try {
            ws.close(1000, `pty exited${result.meta.exitCode === undefined ? '' : ` (${result.meta.exitCode})`}`)
          } catch {}
          return
        }
        state.ptyId = result.meta.id
        state.handle = result.handle
        if (result.kind === 'created') {
          logger.info('[proxy] pty websocket lookup-or-create minted a new pty', {
            requestedId: requestedId ?? null,
            id: result.meta.id,
          })
        }
        if (result.handle.replay) {
          try { ws.send(result.handle.replay) } catch {}
        }
      },
      message(ws: ServerWebSocket<PtyWsData>, message: string | Buffer) {
        ws.data.handle?.write(typeof message === 'string' ? message : message.toString())
      },
      close(ws: ServerWebSocket<PtyWsData>) {
        ws.data.handle?.detach()
      },
    },
  })

  const boundPort = server.port ?? cfg.servicePort
  logger.info('[proxy] listening', { port: boundPort, hostname: '0.0.0.0' })

  return {
    port: boundPort,
    reload(next: Config) {
      currentCfg = next
      app = buildDaemonApp(next, harness, bootTime, bootState, projectEnv, staticWebPort, ptyRegistry)
      logger.info('[proxy] reloaded with session config', { projectId: next.projectId })
    },
    async stop() {
      server.stop(true)
    },
  }
}
