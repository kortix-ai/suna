import { Hono } from 'hono'

import type { Config } from '../config'
import { commitAndPushWorkingTree } from '../git'
import { logger } from '../logger'

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

/**
 * Daemon git control surface (`/kortix/git/*`). Today just `commit-push`: the
 * API calls it (authenticated with the sandbox service key == KORTIX_TOKEN) to
 * commit + push the workspace so the dashboard could open a change request
 * without asking the agent to do it.
 *
 * NOTE (2026-05-29): currently UNUSED. The product flow intentionally lets the
 * agent commit + open the change request from a single chat prompt (cleaner,
 * one mental model), so nothing in the UI calls the API endpoint that fronts
 * this route. Kept wired + tested as the host-driven primitive for a future
 * fully-UI change-request flow. Safe to delete if that direction is abandoned.
 */
export function createGitRouter(cfg: Config): Hono {
  const router = new Hono()
  let inFlight: Promise<Response> | null = null

  router.post('/commit-push', async (c) => {
    if (!cfg.kortixToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    if (bearerToken(c.req.header('Authorization')) !== cfg.kortixToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (inFlight) {
      return c.json({ error: 'commit-push already running' }, 409)
    }

    inFlight = (async () => {
      try {
        const body = (await c.req.json().catch(() => null)) as { message?: unknown } | null
        const message = typeof body?.message === 'string' ? body.message : undefined
        const result = await commitAndPushWorkingTree(cfg, { message })
        logger.info('[git] commit-push', result)
        return c.json({ ok: true, ...result })
      } catch (err) {
        const message = (err as Error).message || 'commit-push failed'
        logger.error('[git] commit-push failed', err)
        const status = message.includes('not materialized') || message.includes('no branch')
          ? 409
          : 500
        return c.json({ error: 'commit-push failed', message }, status)
      } finally {
        inFlight = null
      }
    })()

    return inFlight
  })

  return router
}
