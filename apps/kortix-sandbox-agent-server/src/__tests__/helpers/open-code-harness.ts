import type { Config } from '../../config'
import type { ProjectEnvStore } from '../../project-env'
import type { OpenCodeBootState } from '../../harness/open-code/boot-state'
import { requireOpenCodeConfig } from '../../harness/open-code/config'
import type { Opencode } from '../../harness/open-code/lifecycle'
import { composeOpenCodeHarnessService } from '../../harness/open-code/service'
import { buildDaemonApp } from '../../proxy'
import type { PtyRegistry } from '../../routes/pty'

/** The production daemon app over the production service composition; only
 *  the native OpenCode lifecycle is substituted. */
export function buildOpenCodeTestApp(
  cfg: Config,
  lifecycle: Opencode,
  bootTime: number,
  bootState?: OpenCodeBootState,
  projectEnv?: ProjectEnvStore,
  staticWebPort?: number | null,
  ptyRegistry?: PtyRegistry,
  agentEnvFile?: string,
) {
  return buildDaemonApp(
    cfg,
    composeOpenCodeHarnessService(requireOpenCodeConfig(cfg), lifecycle),
    bootTime,
    bootState,
    projectEnv,
    staticWebPort,
    ptyRegistry,
    agentEnvFile,
  )
}
