/**
 * GET /kortix/part/:sessionID/:messageID/:partID — attachment bytes on demand.
 *
 * The proxy strips inline `data:` attachment bytes out of message-list
 * responses (inline-attachments.ts) and hands the UI a reference to this
 * route instead. Two places hold an attachment:
 *   - a top-level `file` part of the message;
 *   - a tool part's `state.attachments[]` (screenshots a tool returned) —
 *     each entry is a file-shaped object with its own `id`. Until 2026-08-25
 *     this route only searched top-level parts, so every tool screenshot
 *     404'd on demand.
 * An attachment the offload moved to a sidecar (attachment-offload.ts,
 * `kortix.offloaded`) is served from that file; the row only holds a 1×1
 * placeholder.
 */
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import type { AttachmentLike } from '../attachment-offload'
import { inlineAttachmentsOf } from '../attachment-offload'
import { logger } from '../logger'
import type { Opencode } from '../opencode'

export function findAttachment(
  parts: Array<Record<string, unknown>> | undefined,
  partID: string,
): AttachmentLike | null {
  for (const part of parts ?? []) {
    if (!part || typeof part !== 'object') continue
    for (const a of inlineAttachmentsOf(part)) {
      if (a.id === partID) return a
    }
  }
  return null
}

function bytesResponse(bytes: Buffer, mime: string, etag: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: etag,
    },
  })
}

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
    let message: { parts?: Array<Record<string, unknown>> }
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
    const part = findAttachment(message.parts, partID)
    if (!part || typeof part.url !== 'string') {
      return c.json({ error: 'part not found' }, 404)
    }
    if (part.kortix?.offloaded) {
      try {
        const bytes = readFileSync(part.kortix.sidecar)
        return bytesResponse(bytes, part.kortix.mime || part.mime || 'application/octet-stream', etag)
      } catch (err) {
        logger.error('[part] offloaded sidecar unreadable', { sidecar: part.kortix.sidecar, err: (err as Error).message })
        return c.json({ error: 'attachment bytes missing', sidecar: part.kortix.sidecar }, 410)
      }
    }
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(part.url)
    if (!match) {
      return c.redirect(part.url, 302)
    }
    const mimeFromUrl = match[1]
    const isBase64 = Boolean(match[2])
    const payload = match[3] ?? ''
    const bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    return bytesResponse(bytes, part.mime || mimeFromUrl || 'application/octet-stream', etag)
  })

  return app
}
