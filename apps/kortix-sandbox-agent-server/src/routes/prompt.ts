import { Hono } from 'hono'
import { logger } from '../logger'
import { readPinnedOpencodeSessionId, resolveOpencodeModel } from '../main'
import type { Config } from '../config'

/**
 * POST /kortix/prompt — accepts `{ text: string }` and forwards it as a
 * follow-up user message to the opencode session that was pinned at boot
 * (when KORTIX_INITIAL_PROMPT was first delivered).
 *
 * Used by apps/api for chat-thread continuity: a Slack thread reply hits
 * the webhook, the webhook looks up the session for that thread, and
 * forwards the new message here instead of spawning a fresh sandbox.
 */
export function createPromptRouter(cfg: Config): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    let body: { text?: string }
    try {
      body = (await c.req.json()) as { text?: string }
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
    }
    const text = (body.text ?? '').trim()
    if (!text) return c.json({ ok: false, error: '`text` is required' }, 400)

    const opencodeSessionId = readPinnedOpencodeSessionId()
    if (!opencodeSessionId) {
      return c.json(
        {
          ok: false,
          error: 'No opencode session pinned. Did the sandbox boot with KORTIX_INITIAL_PROMPT?',
        },
        409,
      )
    }

    const workspace = process.env.KORTIX_WORKSPACE || '/workspace'
    const baseUrl = `http://127.0.0.1:${cfg.opencodeInternalPort}`
    const url = `${baseUrl}/session/${encodeURIComponent(opencodeSessionId)}/prompt_async?directory=${encodeURIComponent(
      workspace,
    )}`

    const model = resolveOpencodeModel()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
        ...(model ? { model } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const errText = await res.text()
      logger.warn('[prompt] opencode prompt_async failed', {
        sessionId: opencodeSessionId,
        status: res.status,
        body: errText.slice(0, 500),
      })
      return c.json(
        { ok: false, error: `opencode prompt failed: ${res.status}`, detail: errText.slice(0, 500) },
        502,
      )
    }
    logger.info('[prompt] follow-up delivered', { sessionId: opencodeSessionId, bytes: text.length })
    return c.json({ ok: true, opencode_session_id: opencodeSessionId, bytes: text.length })
  })

  return app
}
