import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import type { HarnessControlOperations } from '@/harness/contract/control'
import { logger } from '@/lib/log/logger'
import { authorizeControl } from './control-auth'

/**
 * `/kortix/catalog` — the model catalog's on-demand converge.
 *
 * `POST /converge` with a body `{ "model": "<wire id>" }` registers the one
 * model a turn asks for, of any provider. The API's turn-start gate awaits it.
 * Without a body it registers everything the project's listing serves. Both
 * apply by one idle-gated config reload, never across a running turn. See
 * `convergeManagedModelCatalog` (harness/open-code/lifecycle.ts).
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/
export function createCatalogRouter(cfg: Config, control: HarnessControlOperations): Hono {
  const router = new Hono()

  router.post('/converge', async (c) => {
    const auth = authorizeControl(c, cfg, 'catalog')
    if (auth.response) return auth.response
    if (!control.convergeCatalog) {
      return c.json({ error: 'managed-model catalog convergence is not supported by this runtime' }, 404)
    }
    try {
      const body = (await c.req.json().catch(() => null)) as { model?: unknown } | null
      const model = typeof body?.model === 'string' && MODEL_ID.test(body.model) ? body.model : undefined
      return c.json(await control.convergeCatalog(model ? { model } : undefined))
    } catch (err) {
      logger.error('[catalog] convergence failed', err)
      return c.json({ error: 'catalog convergence failed', message: (err as Error).message }, 500)
    }
  })

  return router
}
