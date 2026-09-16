import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessControlOperations } from '../harness/control'
import { logger } from '../logger'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'

// POST /kortix/abort interrupts the pinned session's current turn.
export function createAbortRouter(cfg: Config, control: HarnessControlOperations): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) {
      logger.warn('[abort] reject', { reason: auth.reason })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }

    const result = await control.abort()
    switch (result.outcome) {
      case 'not-pinned': return c.json(result.body, 409)
      case 'failed': return c.json(result.body, 502)
      case 'aborted': return c.json(result.body)
    }
  })

  return app
}
