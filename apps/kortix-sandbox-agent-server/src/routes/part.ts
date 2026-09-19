/** HTTP caching and delivery for attachment bytes resolved by the selected harness. */
import { Hono } from 'hono'
import type { HarnessAttachmentService } from '../harness/queries'

export function createPartRouter(attachments: HarnessAttachmentService): Hono {
  const app = new Hono()
  app.get('/:sessionID/:messageID/:partID', async (c) => {
    const { sessionID, messageID, partID } = c.req.param()
    const etag = `"${partID}"`
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }
    const result = await attachments.read({ sessionId: sessionID, messageId: messageID, partId: partID })
    if (result.kind === 'error') {
      return c.json(
        result.body,
        result.reason === 'missing-bytes' ? 410 : result.reason === 'not-found' ? 404 : 502,
      )
    }
    if (result.kind === 'redirect') return c.redirect(result.location, 302)
    // The bytes are ArrayBuffer-backed; the DOM lib the API's typecheck uses
    // admits only `Uint8Array<ArrayBuffer>` as a body, hence the cast.
    return new Response(result.bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'Content-Type': result.mime,
        'Content-Length': String(result.bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: etag,
      },
    })
  })
  return app
}
