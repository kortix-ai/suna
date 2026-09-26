import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessControlOperations } from '../harness/control'
import { KORTIX_SERVICE_CALL_HEADER } from '../kortix-user-context'
import { logger } from '../logger'
import { runConvergence } from './config'
import { authorizeControl } from './control-auth'

export function createRefreshRouter(cfg: Config, control: HarnessControlOperations): Hono {
  const router = new Hono()
  let refreshInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    const auth = authorizeControl(c, cfg, 'refresh')
    if (auth.response) return auth.response
    const serviceAuthenticated = auth.serviceAuthenticated

    // `?config_dir=1` is an alias of `POST /kortix/config/converge`, for an API
    // that predates config releases. It fetches the desired release from the
    // API and applies it; every other refresh flag is ignored, and the working
    // tree is never written. A runtime without config releases (pi) keeps the
    // plain refresh it always did for this flag.
    if (c.req.query('config_dir') === '1' && c.req.query('base') !== '1' && control.convergeConfig) {
      return runConvergence(c, control)
    }

    if (refreshInFlight) {
      return c.json({ error: 'refresh already running' }, 409)
    }

    // `?base=1` syncs a restored warm-snapshot workspace to the latest base tip;
    // `?restart=0` skips the opencode restart (the file watcher picks up changes
    // and keeps warm-snapshot restore fast). Default behaviour is refresh+restart.
    const syncBase = c.req.query('base') === '1'
    // `base=1` force-resets the session's own branch onto the base tip
    // (`syncWorkspaceToBase` → `git checkout -B <cfg.branchName> <sha>`, and
    // branchName IS the session id), discarding every commit the session made
    // and deleting the files they introduced.
    //
    // The API's own reload deliberately refuses to send it. But the endpoint is
    // reachable through the user-facing sandbox proxy — that proxy blocks
    // exactly one daemon path, `/kortix/env`, and this is not it — so any
    // principal who can see the session could wipe its history with one request,
    // as could the in-box agent via a prompt-injected `curl` against localhost.
    //
    // Its only legitimate caller is the warm-session workspace refresh, at
    // session CREATE, calling us DIRECTLY.
    //
    // The bearer alone cannot express that. The proxy authenticates everything
    // it relays — an ordinary user's request included — with this very sandbox's
    // service key, so `serviceAuthenticated` is true for user traffic too and a
    // bearer-only gate would be decoration. What the proxy does NOT relay is
    // KORTIX_SERVICE_CALL_HEADER: it strips it from every forwarded request, so
    // only a direct platform call can present it.
    //
    // Require BOTH. The header proves the hop, the bearer proves the caller, and
    // neither is sufficient alone: the header is unauthenticated on its own, and
    // the bearer is available to anything the proxy speaks to.
    if (syncBase && !(serviceAuthenticated && c.req.header(KORTIX_SERVICE_CALL_HEADER) === '1')) {
      logger.warn('[refresh] rejected base=1 from a non-service caller')
      return c.json(
        {
          error: 'base reset requires the sandbox service credential',
          code: 'BASE_RESET_FORBIDDEN',
        },
        403,
      )
    }
    const skipRestart = c.req.query('restart') === '0'
    // `?repo=0` — leave the checkout exactly as it is. Converging the config no
    // longer involves the working tree, so the web's "Reload config" can load
    // the base branch's agents without the `git pull` it has always declined to
    // trigger from a UI click. An older daemon ignores the flag and runs its
    // `--ff-only` pull, which cannot discard anything.
    const skipRepo = c.req.query('repo') === '0'
    const baseSha = c.req.query('base_sha')
    if (baseSha !== undefined && !/^[0-9a-f]{40}$/i.test(baseSha)) {
      return c.json({ error: 'invalid base_sha' }, 400)
    }

    refreshInFlight = (async () => {
      try {
        return c.json(await control.refresh({
          syncBase,
          skipRestart,
          skipRepo,
          baseSha,
          forceFail: c.req.query('verify_fail') === '1',
        }))
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
