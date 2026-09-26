import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessControlOperations } from '../harness/control'
import { logger } from '../logger'
import { authorizeControl } from './control-auth'

/**
 * `/kortix/catalog` — the managed-model catalog's on-demand converge.
 *
 * `POST /converge` fetches the live managed lineup and, ONLY if the box's
 * booted provider map is missing something it serves, repairs the overlay
 * file and takes one verified OpenCode restart (idle-gated, never across a
 * running turn). The API's turn-start gate calls this AWAITED, and only when
 * the model THIS turn asked for is the one missing — see
 * `convergeManagedModelCatalog` (harness/open-code/lifecycle.ts) for the full
 * design and its non-blocking sibling call in `control.refresh()`.
 *
 * The request body is never read, same reasoning as `/kortix/config/converge`:
 * the daemon fetches the live lineup itself, so a caller that can reach this
 * route cannot choose what it converges to.
 */
export function createCatalogRouter(cfg: Config, control: HarnessControlOperations): Hono {
  const router = new Hono()

  router.post('/converge', async (c) => {
    const auth = authorizeControl(c, cfg, 'catalog')
    if (auth.response) return auth.response
    if (!control.convergeCatalog) {
      return c.json({ error: 'managed-model catalog convergence is not supported by this runtime' }, 404)
    }
    try {
      return c.json(await control.convergeCatalog())
    } catch (err) {
      logger.error('[catalog] convergence failed', err)
      return c.json({ error: 'catalog convergence failed', message: (err as Error).message }, 500)
    }
  })

  return router
}
