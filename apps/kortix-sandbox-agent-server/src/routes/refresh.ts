import { Hono } from 'hono'

import type { Config } from '../config'
import { refreshRepo, syncWorkspaceToBase } from '../git'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
} from '../kortix-user-context'
import { logger } from '../logger'

export function createRefreshRouter(cfg: Config): Hono {
  const router = new Hono()
  let refreshInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) {
      logger.warn('[refresh] reject', { reason: auth.reason })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }

    if (refreshInFlight) {
      return c.json({ error: 'refresh already running' }, 409)
    }

    // `?base=1` syncs a restored warm-snapshot workspace to the latest base tip.
    const syncBase = c.req.query('base') === '1'

    refreshInFlight = (async () => {
      try {
        const repo = syncBase ? await syncWorkspaceToBase(cfg) : await refreshRepo(cfg)
        return c.json({
          ok: true,
          repo: {
            before: repo.before,
            after: repo.after,
          },
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
