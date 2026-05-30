import { Hono } from 'hono'
import { logger } from '../logger'
import { readPinnedOpencodeSessionId } from '../main'
import type { Config } from '../config'

// POST /kortix/abort — interrupt the in-flight opencode turn for the pinned
// session. apps/api calls this when the user clicks "Stop" on the Slack
// stream. opencode's /session/{id}/abort cancels the running model call and
// any in-flight tools; the next prompt to the same session resumes cleanly.
export function createAbortRouter(cfg: Config): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    const sessionId = readPinnedOpencodeSessionId()
    if (!sessionId) {
      return c.json({ ok: false, error: 'No opencode session pinned.' }, 409)
    }

    const workspace = process.env.KORTIX_WORKSPACE || '/workspace'
    const url = `http://127.0.0.1:${cfg.opencodeInternalPort}/session/${sessionId}/abort?directory=${encodeURIComponent(workspace)}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300)
        logger.warn('[abort] opencode abort failed', { sessionId, status: res.status, body })
        return c.json({ ok: false, error: `opencode abort failed: ${res.status}`, detail: body }, 502)
      }
      logger.info('[abort] opencode turn aborted', { sessionId })
      return c.json({ ok: true, opencode_session_id: sessionId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[abort] opencode abort threw', { sessionId, error: message })
      return c.json({ ok: false, error: message }, 502)
    }
  })

  return app
}
