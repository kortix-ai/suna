import { Hono } from 'hono'

import type { Config } from '../config'
import { refreshRepo } from '../git'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import { logger } from '../logger'
import type { Opencode } from '../opencode'

export function createRefreshRouter(cfg: Config, opencode: Opencode): Hono {
  const router = new Hono()
  let refreshInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    if (!cfg.kortixToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.kortixToken)
    if (!auth.ok) {
      logger.warn('[refresh] reject', { reason: auth.reason })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }

    if (refreshInFlight) {
      return c.json({ error: 'refresh already running' }, 409)
    }

    refreshInFlight = (async () => {
      try {
        const repo = await refreshRepo(cfg)
        await opencode.restart()
        return c.json({
          ok: true,
          repo: {
            before: repo.before,
            after: repo.after,
          },
          opencode: opencode.getState(),
          opencode_pid: opencode.getPid(),
        })
      } catch (err) {
        const message = (err as Error).message || 'refresh failed'
        logger.error('[refresh] failed', err)
        const status = message.includes('not materialized') || message.includes('git pull refresh failed')
          ? 409
          : 500
        return c.json({ error: 'refresh failed', message }, status)
      } finally {
        refreshInFlight = null
      }
    })()

    return refreshInFlight
  })

  return router
}
