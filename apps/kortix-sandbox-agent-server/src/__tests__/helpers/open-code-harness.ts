import { requireOpenCodeConfig } from '../../harness/open-code/config'
import type { Config } from '../../config'
import type { ProjectEnvStore } from '../../project-env'
import type { HarnessService } from '../../harness/harness'
import type { OpenCodeBootState } from '../../harness/open-code/boot-state'
import type { Opencode } from '../../harness/open-code/lifecycle'
import { OPENCODE_HOME } from '../../harness/open-code/paths'
import { createOpenCodeProxyService } from '../../harness/open-code/proxy'
import { createOpenCodeControlService } from '../../harness/open-code/control'
import { createOpenCodeDiagnosticsService } from '../../harness/open-code/diagnostics'
import { createOpenCodeQueryService } from '../../harness/open-code/queries'
import { createOpenCodeAssetsService } from '../../harness/open-code/assets'
import { createOpenCodeQuickQueueInterrupt, startOpenCodeBackground } from '../../harness/open-code/background'
import { buildDaemonApp } from '../../proxy'
import type { PtyRegistry } from '../../routes/pty'

/** Exercise the real service boundary while substituting only native execution. */
export function createOpenCodeHarnessFixture(cfg: Config, lifecycle: Opencode): HarnessService {
  const quickQueue = createOpenCodeQuickQueueInterrupt(lifecycle, cfg)
  return {
    id: 'opencode',
    environment: { home: OPENCODE_HOME },
    lifecycle,
    proxy: createOpenCodeProxyService(lifecycle),
    control: createOpenCodeControlService(lifecycle, quickQueue),
    diagnostics: createOpenCodeDiagnosticsService(lifecycle),
    queries: createOpenCodeQueryService(lifecycle),
    background: { start: (currentCfg) => startOpenCodeBackground(lifecycle, requireOpenCodeConfig(currentCfg), quickQueue) },
    assets: createOpenCodeAssetsService({
      getInternalUrl: () => lifecycle.getInternalUrl(),
      restart: () => lifecycle.restart(),
      workspace: () => cfg.workspace,
    }),
  }
}

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
    createOpenCodeHarnessFixture(cfg, lifecycle),
    bootTime,
    bootState,
    projectEnv,
    staticWebPort,
    ptyRegistry,
    agentEnvFile,
  )
}
