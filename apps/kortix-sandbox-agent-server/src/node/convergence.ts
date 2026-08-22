import { join } from 'node:path'
import { noteRuntimeConvergence, reconcileRuntimeAssets, requestAgentSwapIfIdle, type RuntimeAssetsResult } from '../runtime-assets'
import { nodeStateDirectory } from './config-store'

const DEFAULT_INTERVAL_MS = 5 * 60_000

export interface NodeConvergenceOptions {
  apiUrl: string
  token: string
  busy: () => boolean
  stateDirectory?: string
  intervalMs?: number
  reconcile?: typeof reconcileRuntimeAssets
  manifestSigningPublicKey?: string
}

export function nodeRuntimePaths(stateDirectory = nodeStateDirectory()) {
  const runtime = join(stateDirectory, 'runtime')
  return {
    runtime,
    cliPath: join(stateDirectory, 'bin', process.platform === 'win32' ? 'kortix.exe' : 'kortix'),
    managedSkillsDir: join(stateDirectory, 'managed-skills'),
    statePath: join(runtime, 'assets-state.json'),
  }
}

/** Keep every enrolled host converged, including hosts with no active session. */
export function startNodeConvergence(options: NodeConvergenceOptions) {
  const paths = nodeRuntimePaths(options.stateDirectory)
  let running: Promise<RuntimeAssetsResult> | null = null
  const runNow = () => {
    if (running) return running
    running = (options.reconcile ?? reconcileRuntimeAssets)({
      apiUrl: options.apiUrl,
      token: options.token,
      cliPath: paths.cliPath,
      managedSkillsDir: paths.managedSkillsDir,
      statePath: paths.statePath,
      agentStateDir: paths.runtime,
      agentBakedPath: process.execPath,
      runningAgentPath: process.execPath,
      manifestSigningPublicKey: options.manifestSigningPublicKey,
    }).then(async (result) => {
      noteRuntimeConvergence(result)
      if (result.agent === 'staged') await requestAgentSwapIfIdle({ agentStateDir: paths.runtime, turnInFlight: async () => options.busy(), minUptimeMs: 0 })
      return result
    }).finally(() => { running = null })
    return running
  }
  void runNow()
  const timer = setInterval(() => { void runNow() }, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return { runNow, stop: () => clearInterval(timer), paths }
}
