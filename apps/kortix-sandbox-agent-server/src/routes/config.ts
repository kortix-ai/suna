import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessControlOperations } from '../harness/control'
import { logger } from '../logger'
import { authorizeControl } from './control-auth'

/**
 * `/kortix/config` — config releases. Spec: docs/specs/config-releases.md,
 * "Daemon" → "Routes".
 *
 * `POST /converge` only TRIGGERS a convergence. The request body is never
 * read: the daemon fetches the descriptor from the API itself, so a caller
 * that can reach this route (the in-box agent included) cannot choose the
 * config it runs. The descriptor request carries no inputs either — the
 * desired release is always the base branch's current tip.
 */
export function createConfigRouter(cfg: Config, control: HarnessControlOperations): Hono {
  const router = new Hono()

  router.post('/converge', async (c) => {
    const auth = authorizeControl(c, cfg, 'config')
    if (auth.response) return auth.response
    return runConvergence(c, control)
  })

  return router
}

/** Shared by `POST /kortix/config/converge` and its `?config_dir=1` refresh alias. */
export async function runConvergence(
  c: { json: (body: unknown, status?: 200 | 404 | 409 | 500) => Response },
  control: HarnessControlOperations,
): Promise<Response> {
  if (!control.convergeConfig) {
    return c.json({ error: 'config releases are not supported by this runtime' }, 404)
  }
  try {
    return c.json(await control.convergeConfig())
  } catch (err) {
    if (err instanceof Error && err.name === 'ConvergeBusyError') {
      return c.json({ error: 'config convergence already running' }, 409)
    }
    logger.error('[config] convergence failed', err)
    return c.json({ error: 'config convergence failed', message: (err as Error).message }, 500)
  }
}
