import { Hono } from 'hono'
import type { Config } from '../config'
import type { SandboxBootState } from '../boot-state'
import type { ProjectEnvStore } from '../project-env'
import type { ResourceMonitor } from '../resources'
import type { HarnessService } from '../harness/harness'
import { createHealthRouter } from './health'
import { createRefreshRouter } from './refresh'
import { createConfigRouter } from './config'
import { createAbortRouter } from './abort'
import { createEnvRouter } from './env'
import { createPartRouter } from './part'
import { createLogsRouter } from './logs'
import { createDiagRouter } from './diag'
import { createRuntimeRouter } from './runtime'

export interface HarnessRouteContext {
  cfg: Config
  bootTime: number
  bootState: SandboxBootState
  projectEnv?: ProjectEnvStore
  staticWebPort: number | null
  agentEnvFile?: string
  resources: () => ResourceMonitor | null
}

/** Register the existing public contract independently of adapter selection. */
export function createHarnessControlRouter(harness: HarnessService, context: HarnessRouteContext): Hono {
  const router = new Hono()
  const control = harness.control.bind(context)
  const queries = harness.queries.bind(context)
  const mount = (path: string, controller: Hono) => {
    router.route(path, controller)
    router.route(`${path}/`, controller)
  }
  // `config.release.v1`: the API may send POST /kortix/config/converge.
  // Advertised only by a control that implements it.
  mount('/health', createHealthRouter(context, harness.diagnostics, control.convergeConfig ? ['config.release.v1'] : []))
  mount('/refresh', createRefreshRouter(context.cfg, control))
  mount('/config', createConfigRouter(context.cfg, control))
  mount('/abort', createAbortRouter(context.cfg, control))
  mount('/part', createPartRouter(queries.attachments))
  mount('/logs', createLogsRouter(context.cfg, harness.diagnostics))
  mount('/diag', createDiagRouter(context, harness.diagnostics))
  if (context.projectEnv) mount('/env', createEnvRouter(context.cfg, control))
  // Preserve the existing URL. It is a compatibility contract, not selection.
  mount('/opencode', createRuntimeRouter(context.cfg, queries))
  return router
}
