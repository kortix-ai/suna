import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import type { SandboxBootState } from '@/harness/contract/boot-state'
import type { ProjectEnvStore } from '@/services/sandbox-env/project-env'
import type { ResourceMonitor } from '@/services/resources/resources'
import type { HarnessService } from '@/harness/harness'
import { createHealthRouter } from './health'
import { createRefreshRouter } from './refresh'
import { createConfigRouter } from './config'
import { createAbortRouter } from './abort'
import { createEnvRouter } from './env'
import { createPartRouter } from './part'
import { createLogsRouter } from './logs'
import { createDiagRouter } from './diag'
import { createRuntimeRouter } from './runtime'
import { RUNTIME_ACTIONS_CAPABILITY, RUNTIME_LOG_CAPABILITY, RUNTIME_RETRACT_CAPABILITY, RUNTIME_TURNS_CAPABILITY } from '@kortix/api-contract/runtime-relay'

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
  // `runtime.turns.v1`: the Kortix turn verbs below. Both harnesses serve them.
  // `runtime.retract.v1`: the retract verb among them.
  // `runtime.actions.v1`: the session-log actions and reads (answer, compact, command, grants, log, workspace).
  // `runtime.log.v1`: the log reads answer whole pages, with queued prompts, and health names the root thread.
  const capabilities = [
    RUNTIME_TURNS_CAPABILITY,
    RUNTIME_RETRACT_CAPABILITY,
    RUNTIME_ACTIONS_CAPABILITY,
    RUNTIME_LOG_CAPABILITY,
    ...(control.convergeConfig ? ['config.release.v1'] : []),
  ]
  mount('/health', createHealthRouter(context, harness.diagnostics, capabilities))
  mount('/refresh', createRefreshRouter(context.cfg, control))
  mount('/config', createConfigRouter(context.cfg, control))
  mount('/abort', createAbortRouter(context.cfg, control))
  mount('/part', createPartRouter(context.cfg, queries.attachments))
  mount('/logs', createLogsRouter(context.cfg, harness.diagnostics))
  mount('/diag', createDiagRouter(context, harness.diagnostics))
  if (context.projectEnv) mount('/env', createEnvRouter(context.cfg, control))
  // The Runtime API.
  const runtimeRouter = createRuntimeRouter(context.cfg, queries, {
    turns: harness.turns,
    readiness: () => harness.proxy.readiness(context),
  })
  mount('/runtime', runtimeRouter)
  return router
}
