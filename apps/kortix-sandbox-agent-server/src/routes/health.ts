import { Hono } from 'hono'

import type { Config } from '../config'
import { readRepoInfo } from '../git'
import type { Opencode } from '../opencode'

/**
 * The single Kortix-owned route on the daemon.
 *
 * Shape:
 *   {
 *     daemon: 'ok',
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
export function createHealthRouter(cfg: Config, opencode: Opencode, bootTime: number): Hono {
  const router = new Hono()

  router.get('/', async (c) => {
    const repoInfo = await readRepoInfo(cfg.projectTarget).catch(() => null)
    return c.json({
      daemon: 'ok',
      opencode: opencode.getState(),
      uptime_s: Math.floor((Date.now() - bootTime) / 1000),
      opencode_pid: opencode.getPid(),
      repo: repoInfo?.remoteUrl ?? null,
      branch: repoInfo?.branch ?? null,
      commit_sha: repoInfo?.commit ?? null,
      // Visible auth posture so misconfiguration doesn't silently downgrade.
      auth: cfg.kortixToken ? 'configured' : 'unconfigured',
    })
  })

  return router
}
