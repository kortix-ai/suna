import { requireOpenCodeConfig } from '../../harness/open-code/config'
import type { Config } from '../../config'
import type { ProjectEnvStore } from '../../project-env'
import type { HarnessService } from '../../harness/harness'
import type { OpenCodeBootState } from '../../harness/open-code/boot-state'
import type { Opencode } from '../../harness/open-code/supervisor'
import { OPENCODE_HOME } from '../../harness/open-code/paths'
import { createOpenCodeHttpService } from '../../harness/open-code/http'
import { createOpenCodeAssetsService } from '../../harness/open-code/assets'
import { startOpenCodeBackground } from '../../harness/open-code/background'
import { buildDaemonApp } from '../../proxy'
import type { PtyRegistry } from '../../routes/pty'

/** Exercise the real service boundary while substituting only native execution. */
export function createOpenCodeHarnessFixture(cfg: Config, supervisor: Opencode): HarnessService {
  return {
    id: 'opencode',
    environment: { home: OPENCODE_HOME },
    lifecycle: supervisor,
    http: createOpenCodeHttpService(supervisor),
    background: { start: (currentCfg) => startOpenCodeBackground(supervisor, requireOpenCodeConfig(currentCfg)) },
    assets: createOpenCodeAssetsService({
      getInternalUrl: () => supervisor.getInternalUrl(),
      restart: () => supervisor.restart(),
      workspace: () => cfg.workspace,
    }),
  }
}

export function buildOpenCodeTestApp(
  cfg: Config,
  supervisor: Opencode,
  bootTime: number,
  bootState?: OpenCodeBootState,
  projectEnv?: ProjectEnvStore,
  staticWebPort?: number | null,
  ptyRegistry?: PtyRegistry,
  agentEnvFile?: string,
) {
  return buildDaemonApp(
    cfg,
    createOpenCodeHarnessFixture(cfg, supervisor),
    bootTime,
    bootState,
    projectEnv,
    staticWebPort,
    ptyRegistry,
    agentEnvFile,
  )
}
