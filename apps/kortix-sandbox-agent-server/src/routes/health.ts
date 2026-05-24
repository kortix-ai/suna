import { Hono } from 'hono'

import type { Config } from '../config'
import { readRepoInfo } from '../git'
import type { Opencode } from '../opencode'

export type BootMark = { label: string; atMs: number }

export type SandboxBootState = {
  repoMaterializationError: string | null
  /** In-container boot timeline (ms since process start) for latency benchmarking. */
  timeline: BootMark[]
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
 *     static_web_port: number | null,  // bound static-web port, null if down
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
  staticWebPort: number | null = null,
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
      // Static web server (preview/static files). The bound port when up, else
      // null — surfaces "preview won't load because static-web never bound".
      static_web_port: staticWebPort,
      repo_required: repoRequired,
      repo_ready: repoReady,
      repo: repoInfo?.remoteUrl ?? null,
      branch: repoInfo?.branch ?? null,
      commit_sha: repoInfo?.commit ?? null,
      boot_error: bootState.repoMaterializationError,
      // In-container boot timeline (ms since process start) so the dashboard can
      // attribute the post-create boot latency (clone vs opencode vs proxy).
      boot_timeline: bootState.timeline,
      // Visible auth posture so misconfiguration doesn't silently downgrade.
      auth: cfg.kortixToken ? 'configured' : 'unconfigured',
    })
  })

  return router
}
