/**
 * HTTP caching and delivery for attachment bytes resolved by the selected
 * harness.
 *
 * Same gate as every other route in the /kortix/* namespace (the daemon's
 * global auth gate in proxy.ts exempts this namespace precisely so each
 * route checks its own credential): the sandbox bearer, or a signed
 * X-Kortix-User-Context — see `/kortix/logs` (routes/logs.ts) and the shared
 * `authorizeControl` helper this reuses.
 */
import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessAttachmentService } from '../harness/queries'
import { authorizeControl } from './control-auth'

export function createPartRouter(cfg: Config, attachments: HarnessAttachmentService): Hono {
  const app = new Hono()
  app.get('/:sessionID/:messageID/:partID', async (c) => {
    const auth = authorizeControl(c, cfg, 'part')
    if (auth.response) return auth.response
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
