import { Hono } from 'hono'
import type { HarnessDiagnosticsContext, HarnessDiagnosticsService } from '../harness/diagnostics'

/** Daemon liveness stays HTTP 200 even when the selected runtime is unavailable. */
export function createHealthRouter(
  context: HarnessDiagnosticsContext,
  diagnostics: HarnessDiagnosticsService,
): Hono {
  const router = new Hono()
  router.get('/', async (c) => {
    const turn = c.req.query('turn') === '1'
      ? {
          sessionId: c.req.query('turn_session_id')?.trim(),
          messageId: c.req.query('turn_message_id')?.trim(),
        }
      : undefined
    return c.json(await diagnostics.health(context, { turn }))
  })
  return router
}
