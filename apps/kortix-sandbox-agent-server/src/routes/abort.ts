import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessControlOperations } from '../harness/control'
import { logger } from '../logger'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'

// POST /kortix/abort interrupts the pinned session's current turn.
// /kortix/abort/after-tool arms or disarms an interrupt at the next tool boundary.
export function createAbortRouter(cfg: Config, control: HarnessControlOperations): Hono {
  const app = new Hono()

  const validId = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

  app.post('/after-tool', async (c) => {
    if (!cfg.sandboxToken) return c.json({ error: 'daemon not configured' }, 503)
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!validId(body?.prompt_id) || !validId(body?.opencode_session_id) ||
        !validId(body?.turn_message_id)) {
      return c.json({ error: 'prompt_id, opencode_session_id and turn_message_id are required' }, 400)
    }
    try {
      await control.armAbortAfterTool({
        promptId: body.prompt_id,
        opencodeSessionId: body.opencode_session_id,
        messageId: body.turn_message_id,
      })
      return c.json({ armed: true }, 202)
    } catch (error) {
      logger.warn('[abort] queue interrupt arm failed', { error })
      return c.json({ error: 'queue interrupt unavailable' }, 503)
    }
  })

  app.delete('/after-tool', async (c) => {
    if (!cfg.sandboxToken) return c.json({ error: 'daemon not configured' }, 503)
    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (body?.all === true) {
      control.disarmAbortAfterTool()
      return c.json({ armed: false })
    }
    if (!validId(body?.prompt_id)) return c.json({ error: 'prompt_id is required' }, 400)
    control.disarmAbortAfterTool(body.prompt_id)
    return c.json({ armed: false })
  })

  app.post('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }

    const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
    if (!auth.ok) {
      logger.warn('[abort] reject', { reason: auth.reason })
      return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
    }

    // An explicit Stop wins over a pending automatic queue interrupt.
    control.disarmAbortAfterTool()

    const result = await control.abort()
    switch (result.outcome) {
      case 'not-pinned': return c.json(result.body, 409)
      case 'failed': return c.json(result.body, 502)
      case 'aborted': return c.json(result.body)
    }
  })

  return app
}
