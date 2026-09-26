import { Hono } from 'hono'
import type { Config } from '../config'
import { MAX_SWAP_DELAY_MS, type HarnessControlOperations } from '../harness/control'
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

/**
 * `?delay_before_swap_ms=N` — fault injection, the same shape as `verify_fail`
 * on `POST /kortix/refresh`.
 *
 * It holds the convergence between the turn gate and the swap, which is the
 * window DEF-DEV-1 lived in on a real box (2.4-6.1 s of download and extract).
 * A test that needs a prompt to arrive mid-convergence otherwise has to win a
 * race it cannot observe. It changes no decision — the same gate runs before
 * it and the same promotion check runs after it — and it is bounded by
 * `MAX_SWAP_DELAY_MS`. A caller who can reach this route can already restart
 * opencode outright, so the delay grants nothing new.
 */
function delayBeforeSwapMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, MAX_SWAP_DELAY_MS)
}

/** Shared by `POST /kortix/config/converge` and its `?config_dir=1` refresh alias. */
export async function runConvergence(
  c: {
    json: (body: unknown, status?: 200 | 404 | 409 | 500) => Response
    req: { query: (key: string) => string | undefined }
  },
  control: HarnessControlOperations,
): Promise<Response> {
  if (!control.convergeConfig) {
    return c.json({ error: 'config releases are not supported by this runtime' }, 404)
  }
  try {
    return c.json(
      await control.convergeConfig({
        delayBeforeSwapMs: delayBeforeSwapMs(c.req.query('delay_before_swap_ms')),
      }),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'ConvergeBusyError') {
      return c.json({ error: 'config convergence already running' }, 409)
    }
    logger.error('[config] convergence failed', err)
    return c.json({ error: 'config convergence failed', message: (err as Error).message }, 500)
  }
}
