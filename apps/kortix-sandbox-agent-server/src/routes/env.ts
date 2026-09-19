import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessControlOperations } from '../harness/control'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { logger } from '../logger'

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createEnvRouter(
  cfg: Config,
  control: HarnessControlOperations,
): Hono {
  const router = new Hono()
  let syncInFlight: Promise<Response> | null = null

  router.post('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    if (bearerToken(c.req.header('Authorization')) !== cfg.sandboxToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    // Defense in depth: this is a server-to-server control endpoint. The API's
    // postEnvToDaemon never sends a user-context header; the user-facing /v1/p
    // proxy always does. So a present user-context header means this arrived via
    // the proxy (which should already block /kortix/env) — refuse it.
    if (c.req.header(KORTIX_USER_CONTEXT_HEADER)) {
      logger.warn('[env] rejecting /kortix/env carrying user-context header')
      return c.json({ error: 'forbidden' }, 403)
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
          refreshModels?: unknown
          opencodeEnv?: unknown
          llmGatewayEnabled?: unknown
          llmGatewayBaseUrl?: unknown
          llmGatewayDenyEnv?: unknown
        } | null

        if (!body || typeof body.revision !== 'string') {
          return c.json({ error: 'revision is required' }, 400)
        }
        if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
          return c.json({ error: 'env object is required' }, 400)
        }

        return c.json(await control.applyEnvironment({
          revision: body.revision,
          env: body.env as Record<string, unknown>,
          names: body.names,
          refreshModels: body.refreshModels,
          runtimeEnv: body.opencodeEnv,
          llmGatewayEnabled: body.llmGatewayEnabled,
          llmGatewayBaseUrl: body.llmGatewayBaseUrl,
        }))
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
