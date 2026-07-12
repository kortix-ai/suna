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
import type { ProjectEnvStore } from './project-env'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from './kortix-user-context'
import { createAcpHarnessRegistry } from './acp/harness-registry'
import { AcpRuntime } from './acp/runtime'
import { createAcpRouter } from './routes/acp'

export function buildAcpApp(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState = { repoMaterializationError: null, timeline: [] },
  projectEnv?: ProjectEnvStore,
  staticWebPort: number | null = null,
  acpRuntime: AcpRuntime = new AcpRuntime({ registry: createAcpHarnessRegistry(), cwd: cfg.projectTarget, projectEnv }),
): Hono {
  const app = new Hono()
  const control = new Hono()
  const health = createHealthRouter(cfg, bootTime, bootState, staticWebPort)
  control.route('/health', health)
  control.route('/health/', health)
  control.route('/refresh', createRefreshRouter(cfg))
  control.route('/refresh/', createRefreshRouter(cfg))
  control.route('/git', createGitRouter(cfg))
  control.route('/git/', createGitRouter(cfg))
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
  let currentCfg = cfg
  let app = buildAcpApp(cfg, bootTime, bootState, projectEnv, staticWebPort, acpRuntime)
  const server = Bun.serve({ port: cfg.servicePort, fetch: (request) => app.fetch(request) })
  logger.info('[proxy] ACP daemon listening', { port: server.port })
  return {
    port: server.port ?? cfg.servicePort,
    async stop() { await acpRuntime.shutdown(); server.stop(true) },
    reload(next) {
      currentCfg = next
      app = buildAcpApp(currentCfg, bootTime, bootState, projectEnv, staticWebPort, acpRuntime)
    },
  }
}
