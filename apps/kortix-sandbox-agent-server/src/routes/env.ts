import { Hono } from 'hono'

import type { Config } from '../config'
import { logger } from '../logger'
import type { Opencode } from '../opencode'
import type { ProjectEnvStore } from '../project-env'

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createEnvRouter(cfg: Config, opencode: Opencode, projectEnv: ProjectEnvStore): Hono {
  const router = new Hono()
  let syncInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    if (!cfg.kortixToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    if (bearerToken(c.req.header('Authorization')) !== cfg.kortixToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (syncInFlight) {
      return c.json({ error: 'env sync already running' }, 409)
    }

    syncInFlight = (async () => {
      try {
        const body = await c.req.json().catch(() => null) as {
          revision?: unknown
          env?: unknown
          names?: unknown
        } | null

        if (!body || typeof body.revision !== 'string') {
          return c.json({ error: 'revision is required' }, 400)
        }
        if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
          return c.json({ error: 'env object is required' }, 400)
        }

        const result = projectEnv.apply({
          revision: body.revision,
          env: body.env as Record<string, unknown>,
          names: body.names,
        })

        if (result.changed) {
          logger.info('[env] project env changed; restarting opencode', {
            revision: result.revision,
            names: result.names.length,
          })
          await opencode.restart()
        }

        return c.json({
          ok: true,
          changed: result.changed,
          revision: result.revision,
          names: result.names,
          opencode: opencode.getState(),
          opencode_pid: opencode.getPid(),
        })
      } catch (err) {
        const message = (err as Error).message || 'env sync failed'
        logger.error('[env] sync failed', err)
        return c.json({ error: 'env sync failed', message }, 500)
      } finally {
        syncInFlight = null
      }
    })()

    return syncInFlight
  })

  return router
}
