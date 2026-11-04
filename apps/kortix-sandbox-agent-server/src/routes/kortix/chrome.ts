import { Hono, type Context } from 'hono'
import type { Config } from '@/lib/config/config'
import { chromeBridge, type ChromeBridge } from '@/services/chrome/chrome-bridge'
import { KORTIX_USER_CONTEXT_HEADER } from '@/lib/kortix-api/kortix-user-context'
import { authorizeControl } from './control-auth'
import { KORTIX_USER_CONTEXT_QUERY_PARAM } from './runtime'

/**
 * The session owner's own browser answers only the in-box CLI. The preview
 * proxy relays a collaborator's request with this box's bearer too, so the
 * bearer cannot tell them apart; the signed user context only the proxy adds
 * can. A relayed request never reaches the owner's Chrome.
 */
function relayed(c: Context): boolean {
  return Boolean(c.req.header(KORTIX_USER_CONTEXT_HEADER) || c.req.query(KORTIX_USER_CONTEXT_QUERY_PARAM))
}

/**
 * Local control routes for `kortix chrome` (protocol §8). The CLI calls these
 * with the box's bearer; the bridge websocket itself is upgraded in app/server.ts.
 */
export function createChromeRouter(cfg: Config, bridge: ChromeBridge = chromeBridge): Hono {
  const app = new Hono()

  app.post('/attach', async (c) => {
    const { response } = authorizeControl(c, cfg, 'chrome')
    if (response) return response
    if (relayed(c)) return c.json({ error: 'not found' }, 404)
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const result = await bridge.attach({
      chrome: typeof body.chrome === 'string' && body.chrome ? body.chrome : undefined,
      ask: body.ask === true,
    })
    return c.json(result.body ?? {}, result.status as 200)
  })

  app.post('/release', async (c) => {
    const { response } = authorizeControl(c, cfg, 'chrome')
    if (response) return response
    if (relayed(c)) return c.json({ error: 'not found' }, 404)
    await bridge.release()
    return c.body(null, 204)
  })

  app.get('/status', (c) => {
    const { response } = authorizeControl(c, cfg, 'chrome')
    if (response) return response
    if (relayed(c)) return c.json({ error: 'not found' }, 404)
    return c.json(bridge.status())
  })

  return app
}
