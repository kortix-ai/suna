import { writeAgentEnvFile } from './agent-env-file'
import { configureGlobalGitIdentity, configureGitCredentialHelper, materializeRepo } from './git'
import type { HarnessBootContext, HarnessDefinition } from './harness/harness'
import { logger } from './logger'
import { MonitorRunner, parseMonitorSpecs } from './monitor-runner'
import { createProjectEnvStore } from './project-env'
import { startProxy } from './proxy'
import { installShutdownHandlers } from './shutdown'

/**
 * Monitor mode — the box that watches things 24/7
 * (docs/specs/2026-08-12-monitors.md D4).
 *
 * It shares the session boot exactly up to the repo checkout, because monitor
 * commands ARE repo code and need the same working tree an agent gets. From
 * there it diverges completely: no agent runtime, no LLM, no session. The proxy
 * still binds so /kortix/health answers (the box is otherwise invisible while
 * it is healthy), and MonitorRunner owns everything after that.
 *
 * The repo is checked out at the project's DEFAULT branch: the API omits
 * KORTIX_BRANCH_NAME for a monitor box, so materializeRepo leaves the checkout
 * on default-branch HEAD instead of minting a session branch. A monitor watches
 * what is shipped, not what some session is working on.
 */
export async function runMonitorMode(
  context: HarnessBootContext,
  selected: HarnessDefinition,
): Promise<void> {
  const { cfg, bootTime, bootState, bootMark, staticWeb } = context
  const projectEnv = createProjectEnvStore()
  // Monitor processes inherit this process's env (the provider injected the
  // project's runtime secrets there), and the agent env file keeps the same
  // shell contract a session shell has.
  writeAgentEnvFile(projectEnv)

  const harness = selected.createService(cfg, projectEnv, { onStartupMark: bootMark })

  try {
    await configureGlobalGitIdentity(cfg, harness.environment.home)
    await configureGitCredentialHelper(cfg, harness.environment.home)
  } catch (err) {
    logger.warn('[monitor] git setup failed', { err: err instanceof Error ? err.message : String(err) })
  }
  bootMark('git-identity')

  // The selected service remains stopped. The host can still expose health
  // and its compatibility endpoints without starting an agent process.
  const server = startProxy(cfg, harness, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(harness.lifecycle, server, staticWeb)
  bootMark('proxy-up')

  if (cfg.autoClone) {
    await materializeRepo(cfg).catch((err) => {
      bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
      logger.error('[monitor] repo materialization failed', err)
    })
  }
  bootMark('repo-materialized')

  const specs = parseMonitorSpecs(cfg.monitorsJson)
  // Fail LOUD and INERT, never crash-loop: the reconciler would just re-create
  // a box that exits, so a misconfigured box stays up, answers health, and says
  // exactly what is wrong.
  if (!cfg.projectId || !cfg.apiUrl || !cfg.sandboxToken) {
    logger.error('[monitor] missing project/API/token env; no monitor will run', {
      hasProjectId: !!cfg.projectId,
      hasApiUrl: !!cfg.apiUrl,
      hasToken: !!cfg.sandboxToken,
    })
    return
  }
  if (!cfg.monitorBoxEpoch) {
    // Without the epoch the server rejects every batch with 409. Running the
    // monitors anyway would burn the box's CPU producing events nothing can
    // accept, so don't.
    logger.error('[monitor] KORTIX_MONITOR_BOX_EPOCH is unset; refusing to run monitors')
    return
  }
  if (specs.length === 0) {
    logger.warn('[monitor] no monitors to run; the box is idle')
    return
  }

  const runner = new MonitorRunner({
    apiUrl: cfg.apiUrl,
    projectId: cfg.projectId,
    token: cfg.sandboxToken,
    boxEpoch: cfg.monitorBoxEpoch,
    monitors: specs,
    cwd: cfg.projectTarget,
  })
  runner.start()
  bootMark('monitors-started')
  // Best-effort drain on shutdown: a SIGTERM'd box should deliver the lines it
  // already captured rather than take them to the grave.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void runner.stop()
    })
  }
}
