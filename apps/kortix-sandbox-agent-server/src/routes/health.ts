import { Hono } from 'hono'

import type { Config } from '../config'
import { readRepoInfo } from '../git'
import type { Opencode } from '../opencode'

export type SandboxBootState = {
  repoMaterializationError: string | null
}

/**
 * The single Kortix-owned route on the daemon.
 *
 * Shape:
 *   {
 *     daemon: 'ok',
 *     status: 'ok' | 'starting' | 'down' | 'error',
 *     runtimeReady: boolean,
 *     opencode: 'ok' | 'starting' | 'down',
 *     uptime_s: number,
 *     opencode_pid: number | null,
 *     repo: string | null,    // remote URL of the materialized repo, if any
 *     branch: string | null,
 *     commit_sha: string | null
 *   }
 *
 * Always returns 200 even when opencode is down — this is the daemon's own
 * liveness probe, not opencode's.
 */
export function createHealthRouter(
  cfg: Config,
  opencode: Opencode,
  bootTime: number,
  bootState: SandboxBootState,
): Hono {
  const router = new Hono()

  router.get('/', async (c) => {
    const repoInfo = await readRepoInfo(cfg.projectTarget).catch(() => null)
    const opencodeState = opencode.getState()
    const repoRequired = cfg.autoClone
    const repoReady = !repoRequired || repoInfo !== null
    const runtimeReady = repoReady && !bootState.repoMaterializationError && opencodeState === 'ok'
    const status = runtimeReady
      ? 'ok'
      : bootState.repoMaterializationError
        ? 'error'
        : opencodeState

    return c.json({
      daemon: 'ok',
      status,
      runtimeReady,
      opencode: opencodeState,
      uptime_s: Math.floor((Date.now() - bootTime) / 1000),
      opencode_pid: opencode.getPid(),
      repo_required: repoRequired,
      repo_ready: repoReady,
      repo: repoInfo?.remoteUrl ?? null,
      branch: repoInfo?.branch ?? null,
      commit_sha: repoInfo?.commit ?? null,
      boot_error: bootState.repoMaterializationError,
      // Visible auth posture so misconfiguration doesn't silently downgrade.
      auth: cfg.kortixToken ? 'configured' : 'unconfigured',
    })
  })

  return router
}
