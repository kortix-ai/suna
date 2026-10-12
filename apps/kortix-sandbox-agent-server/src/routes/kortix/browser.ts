import { Hono } from 'hono'
import type { Config } from '@/lib/config/config'
import { browserBridge, type BrowserBridge } from '@/services/browser/browser-bridge'
import { authorizeControl } from './control-auth'

/**
 * Local control routes for `kortix browser` (protocol §8). The CLI calls these
 * with the box's bearer; the bridge websocket itself is upgraded in app/server.ts.
 */
export function createBrowserRouter(cfg: Config, bridge: BrowserBridge = browserBridge): Hono {
  const app = new Hono()

  app.post('/attach', async (c) => {
    const { response } = authorizeControl(c, cfg, 'browser')
    if (response) return response
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const result = await bridge.attach({
      browser: typeof body.browser === 'string' && body.browser ? body.browser : undefined,
      ask: body.ask === true,
    })
    return c.json(result.body ?? {}, result.status as 200)
  })

  app.post('/release', async (c) => {
    const { response } = authorizeControl(c, cfg, 'browser')
    if (response) return response
    await bridge.release()
    return c.body(null, 204)
  })

  app.get('/status', (c) => {
    const { response } = authorizeControl(c, cfg, 'browser')
    if (response) return response
    return c.json(bridge.status())
  })

  return app
}
