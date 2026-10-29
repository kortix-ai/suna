import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import { chromeBridge, type ChromeBridge } from '@/services/chrome/chrome-bridge'
import { authorizeControl } from './control-auth'

/**
 * Local control routes for `kortix chrome` (protocol §8). The CLI calls these
 * with the box's bearer; the bridge websocket itself is upgraded in app/server.ts.
 */
export function createChromeRouter(cfg: Config, bridge: ChromeBridge = chromeBridge): Hono {
  const app = new Hono()

  app.post('/attach', async (c) => {
    const { response } = authorizeControl(c, cfg, 'chrome')
    if (response) return response
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
    await bridge.release()
    return c.body(null, 204)
  })

  app.get('/status', (c) => {
    const { response } = authorizeControl(c, cfg, 'chrome')
    if (response) return response
    return c.json(bridge.status())
  })

  return app
}
