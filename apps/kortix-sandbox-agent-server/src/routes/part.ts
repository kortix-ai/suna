import { Hono } from 'hono'
import { logger } from '../logger'
import type { Opencode } from '../opencode'

/**
 * GET /kortix/part/:sessionID/:messageID/:partID — the BYTES of one attachment.
 *
 * The transcript list (`GET /session/:id/message`) no longer carries file
 * bytes: `stripInlineAttachmentBytes` in the proxy swaps every oversized
 * `data:` url for a path to this route, so a session with hundreds of image
 * reads lists in kilobytes instead of tens of megabytes. This is where those
 * bytes are fetched from — one part at a time, only when a row is on screen.
 *
 * Source of truth is still opencode: the single-message read
 * (`/session/:id/message/:mid`) returns the part with its `data:` url intact,
 * and we decode it here. No second copy of the bytes anywhere.
 *
 * A part never changes once written, so the response is `immutable` with a
 * strong ETag on the part id: the browser asks once per part, ever.
 */
export function createPartRouter(opencode: Opencode): Hono {
  const app = new Hono()

  app.get('/:sessionID/:messageID/:partID', async (c) => {
    const { sessionID, messageID, partID } = c.req.param()
    const etag = `"${partID}"`
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    const workspace = process.env.KORTIX_WORKSPACE || '/workspace'
    const url =
      `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionID)}` +
      `/message/${encodeURIComponent(messageID)}?directory=${encodeURIComponent(workspace)}`

    let message: { parts?: Array<{ id?: string; url?: string; mime?: string }> }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) {
        return c.json({ error: 'message not found', status: res.status }, res.status === 404 ? 404 : 502)
      }
      message = (await res.json()) as typeof message
    } catch (err) {
      logger.error('[part] upstream read failed', err)
      return c.json({ error: 'upstream unreachable' }, 502)
    }

    const part = message.parts?.find((p) => p?.id === partID)
    if (!part || typeof part.url !== 'string') {
      return c.json({ error: 'part not found' }, 404)
    }

    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(part.url)
    if (!match) {
      // Not inline — it is a real URL the client can follow itself.
      return c.redirect(part.url, 302)
    }
    const mimeFromUrl = match[1]
    const isBase64 = Boolean(match[2])
    const payload = match[3] ?? ''
    const bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': part.mime || mimeFromUrl || 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: etag,
      },
    })
  })

  return app
}
