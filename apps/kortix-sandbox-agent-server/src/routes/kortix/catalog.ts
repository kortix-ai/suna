import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import type { HarnessControlOperations } from '@/harness/contract/control'
import { logger } from '@/lib/log/logger'
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
 * An optional body `{ "model": "<wire id>" }` names the one model a turn
 * asks for, of any provider. It only selects WHICH id to check for: the
 * daemon still fetches the catalog itself, so a caller cannot choose what it
 * converges to. Without it, the route converges the managed lineup.
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
