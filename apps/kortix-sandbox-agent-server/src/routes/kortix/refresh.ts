import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import type { HarnessControlOperations } from '@/harness/contract/control'
import { KORTIX_SERVICE_CALL_HEADER } from '@/lib/kortix-api/kortix-user-context'
import { logger } from '@/lib/log/logger'
import { runSandboxOnBoot } from '@/harness/shared/on-boot'
import { authorizeControl } from './control-auth'

interface RefreshRouterDeps {
  runSandboxOnBoot: (cfg: Config) => void
}

const defaultDeps: RefreshRouterDeps = { runSandboxOnBoot }

export function createRefreshRouter(
  cfg: Config,
  control: HarnessControlOperations,
  deps: RefreshRouterDeps = defaultDeps,
): Hono {
  const router = new Hono()
  let refreshInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    const auth = authorizeControl(c, cfg, 'refresh')
    if (auth.response) return auth.response
    const serviceAuthenticated = auth.serviceAuthenticated

    if (refreshInFlight) {
      return c.json({ error: 'refresh already running' }, 409)
    }

    // `?on_boot=1` reruns the project's boot hook after a provider resume. Only
    // a DIRECT platform call may ask for it: the preview proxy authenticates the
    // user traffic it relays with this sandbox's own bearer, but it strips
    // KORTIX_SERVICE_CALL_HEADER from every forwarded request. The header proves
    // the hop, the bearer proves the caller; neither is sufficient alone.
    const rerunOnBoot = c.req.query('on_boot') === '1'
    const directServiceCall =
      serviceAuthenticated && c.req.header(KORTIX_SERVICE_CALL_HEADER) === '1'
    if (rerunOnBoot && !directServiceCall) {
      logger.warn('[refresh] rejected on_boot=1 from a non-service caller')
      return c.json(
        { error: 'boot hook requires the sandbox service credential', code: 'BOOT_HOOK_FORBIDDEN' },
        403,
      )
    }
    // `?repo=0` — leave the checkout exactly as it is. The web's "Reload config"
    // and a provider resume refresh without the `git pull`.
    const skipRepo = c.req.query('repo') === '0'

    refreshInFlight = (async () => {
      try {
        const result = await control.refresh({ skipRepo })
        if (rerunOnBoot) deps.runSandboxOnBoot(cfg)
        return c.json({
          ...result,
          on_boot: rerunOnBoot ? 'started' : undefined,
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
