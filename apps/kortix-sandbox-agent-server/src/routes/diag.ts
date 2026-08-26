/**
 * GET /kortix/diag — one call, the whole error report.
 *
 * Everything an incident needs from a box, in one JSON document:
 *   - the daemon's view of OpenCode (state, pid, port, boot phase, timeline)
 *   - a fresh resource snapshot (memory, cgroup, load, disk, RSS, duplicate
 *     opencode processes) plus the last periodic one
 *   - the runtime-assets convergence report (which build of what is live)
 *   - the tail of the daemon log and of OpenCode's log (`?tail=N`, default
 *     200, max 2000 — the plain-text `/kortix/logs` route serves more)
 *   - process/runtime identity: daemon pid, Bun version, uptime, workspace
 *
 * Nothing secret: no env dump, no tokens. Same auth as `/kortix/logs`.
 */
import { Hono } from 'hono'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import { daemonLogFilePath, logger } from '../logger'
import type { Opencode } from '../opencode'
import type { ResourceMonitor } from '../resources'
import { runtimeConvergenceReport } from '../runtime-assets'
import type { SandboxBootState } from './health'
import { opencodeLogFilePath, tailFile } from './logs'

const DEFAULT_DIAG_TAIL = 200
const MAX_DIAG_TAIL = 2_000

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export interface DiagDeps {
  opencode: Opencode
  bootTime: number
  bootState: SandboxBootState
  opencodeHome: string
  resources: () => ResourceMonitor | null
}

export function createDiagRouter(cfg: Config, deps: DiagDeps): Hono {
  const router = new Hono()

  router.get('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    const serviceAuthenticated = bearerToken(c.req.header('Authorization')) === cfg.sandboxToken
    if (!serviceAuthenticated) {
      const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
      if (!auth.ok) {
        logger.warn('[diag] reject', { reason: auth.reason })
        return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
      }
    }
    const n = Number(c.req.query('tail'))
    const tail = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_DIAG_TAIL) : DEFAULT_DIAG_TAIL

    const monitor = deps.resources()
    const [resourcesNow, runtime] = await Promise.all([
      monitor ? monitor.tick('diag').catch(() => null) : Promise.resolve(null),
      runtimeConvergenceReport().catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
    ])
    const daemonLog = daemonLogFilePath()
    const opencodeLog = opencodeLogFilePath(deps.opencodeHome)

    return c.json({
      at: new Date().toISOString(),
      daemon: {
        pid: process.pid,
        bun: typeof Bun !== 'undefined' ? Bun.version : null,
        uptime_s: Math.floor((Date.now() - deps.bootTime) / 1000),
        workspace: cfg.workspace,
        service_port: cfg.servicePort,
        daemon_log_file: daemonLog,
      },
      opencode: {
        state: deps.opencode.getState(),
        pid: deps.opencode.getPid(),
        port: deps.opencode.getActivePort(),
        internal_url: deps.opencode.getInternalUrl(),
        binary: deps.opencode.getBinaryPath(),
        port_pair: [cfg.opencodeInternalPort, cfg.opencodeStandbyPort],
        session_id: deps.bootState.initialOpenCodeSessionId ?? null,
        log_file: opencodeLog,
      },
      boot: {
        repo_materialization_error: deps.bootState.repoMaterializationError,
        initial_session_error: deps.bootState.initialOpenCodeSessionError ?? null,
        timeline: deps.bootState.timeline,
      },
      resources: resourcesNow,
      resources_previous: monitor?.latest() ?? null,
      runtime,
      logs: {
        tail,
        daemon: daemonLog ? tailFile(daemonLog, tail) : null,
        opencode: tailFile(opencodeLog, tail),
      },
    })
  })

  return router
}
