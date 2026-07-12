import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import type { Config } from './config'
import { logger } from './logger'
import { createHealthRouter, type SandboxBootState } from './routes/health'
import { createRefreshRouter } from './routes/refresh'
import { createEnvRouter } from './routes/env'
import { createGitRouter } from './routes/git'
import { createPortProxyRouter } from './routes/port-proxy'
import { createFilesRouter } from './routes/files'
import { createFindRouter } from './routes/find'
import { createPresentationRouter } from './routes/presentation'
import webProxyRouter from './routes/web-proxy'
import { createPtyRegistry, createPtyRouter, type PtyAttachHandle, type PtyRegistry } from './routes/pty'
import type { ProjectEnvStore } from './project-env'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from './kortix-user-context'
import { createAcpHarnessRegistry } from './acp/harness-registry'
import { AcpRuntime } from './acp/runtime'
import { createAcpRouter } from './routes/acp'

const KORTIX_PTY_WS_PATH_RE = /^\/kortix\/pty\/([^/]+)\/connect\/?$/
const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

type KortixPtyWsData = {
  ptyId: string
  handle?: PtyAttachHandle
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function prepareKortixPtyWsUpgrade(
  req: Request,
  cfg: Config,
): { ok: true; data: KortixPtyWsData } | { ok: false; response: Response } {
  const url = new URL(req.url)
  const match = KORTIX_PTY_WS_PATH_RE.exec(url.pathname)
  if (!match) return { ok: false, response: jsonError(404, { error: 'unsupported websocket path' }) }
  const ptyId = match[1]!

  if (!cfg.sandboxToken) {
    logger.warn('[pty] rejecting websocket: KORTIX_TOKEN not configured')
    return { ok: false, response: jsonError(503, { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }) }
  }

  const header = req.headers.get(KORTIX_USER_CONTEXT_HEADER) ?? url.searchParams.get(KORTIX_USER_CONTEXT_QUERY_PARAM)
  const auth = verifyKortixUserContext(header, cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn('[pty] reject websocket', { reason: auth.reason, path: url.pathname })
    return { ok: false, response: jsonError(401, { error: 'unauthorized', reason: auth.reason }) }
  }

  return { ok: true, data: { ptyId } }
}

export function buildAcpApp(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
  acpRuntime: AcpRuntime = new AcpRuntime({ registry: createAcpHarnessRegistry(), cwd: cfg.projectTarget, projectEnv }),
  ptyRegistry: PtyRegistry = createPtyRegistry(cfg),
): Hono {
  const app = new Hono()
  const control = new Hono()
  const health = createHealthRouter(cfg, bootTime, bootState, staticWebPort)
  const pty = createPtyRouter(cfg, ptyRegistry)
  control.route('/health', health)
  control.route('/health/', health)
  control.route('/refresh', createRefreshRouter(cfg))
  control.route('/refresh/', createRefreshRouter(cfg))
  control.route('/git', createGitRouter(cfg))
  control.route('/git/', createGitRouter(cfg))
  control.route('/pty', pty)
  control.route('/pty/', pty)
  if (projectEnv) {
    control.route('/env', createEnvRouter(cfg, projectEnv))
    control.route('/env/', createEnvRouter(cfg, projectEnv))
  }
  app.route('/kortix', control)

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/kortix/')) return next()
    if (!cfg.sandboxToken) return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) {
      logger.warn('[proxy] reject', { reason: auth.reason, path })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }
    return next()
  })

  app.route('/proxy', createPortProxyRouter({ blockedPorts: new Set([cfg.servicePort]) }))
  app.route('/web-proxy', webProxyRouter)
  app.route('/file', createFilesRouter(cfg))
  app.route('/find', createFindRouter(cfg))
  app.route('/presentation', createPresentationRouter(cfg))
  app.route('/acp', createAcpRouter(acpRuntime))
  app.all('*', (c) => c.json({ error: 'not found' }, 404))
  return app
}

export type ProxyServer = { stop(): Promise<void>; port: number; reload(next: Config): void }

export function startProxy(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
  providedAcpRuntime?: AcpRuntime,
): ProxyServer {
  const acpRuntime = providedAcpRuntime ?? new AcpRuntime({ registry: createAcpHarnessRegistry(), cwd: cfg.projectTarget, projectEnv })
  const ptyRegistry = createPtyRegistry(cfg)
  let currentCfg = cfg
  let app = buildAcpApp(cfg, bootTime, bootState, projectEnv, staticWebPort, acpRuntime, ptyRegistry)
  const server = Bun.serve<KortixPtyWsData>({
    port: cfg.servicePort,
    hostname: '0.0.0.0',
    idleTimeout: 255,
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
      open(ws: ServerWebSocket<KortixPtyWsData>) {
        const state = ws.data
        const handle = ptyRegistry.attach(state.ptyId, {
          onData: (chunk) => {
            try { ws.send(chunk) } catch {}
          },
          onExit: (exitCode) => {
            try { ws.close(1000, `pty exited${exitCode === null ? '' : ` (${exitCode})`}`) } catch {}
          },
        })
        if (!handle) {
          try { ws.close(1011, 'pty not found') } catch {}
          return
        }
        state.handle = handle
        if (handle.replay) {
          try { ws.send(handle.replay) } catch {}
        }
      },
      message(ws: ServerWebSocket<KortixPtyWsData>, message: string | Buffer) {
        ws.data.handle?.write(typeof message === 'string' ? message : message.toString())
      },
      close(ws: ServerWebSocket<KortixPtyWsData>) {
        ws.data.handle?.detach()
      },
    },
  })
  logger.info('[proxy] ACP daemon listening', { port: server.port, hostname: '0.0.0.0' })
  return {
    port: server.port ?? cfg.servicePort,
    async stop() { await acpRuntime.shutdown(); server.stop(true) },
    reload(next) {
      currentCfg = next
      app = buildAcpApp(currentCfg, bootTime, bootState, projectEnv, staticWebPort, acpRuntime, ptyRegistry)
      logger.info('[proxy] reloaded with session config', { projectId: next.projectId })
    },
  }
}
