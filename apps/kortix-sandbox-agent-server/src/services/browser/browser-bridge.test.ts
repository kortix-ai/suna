import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createBrowserRouter } from '@/routes/kortix/browser'
import {
  createBrowserBridge,
  KORTIX_BROWSER_BRIDGE_PATH,
  NO_BROWSER_REASON,
  type BridgeWsData,
  type BrowserBridge,
} from './browser-bridge'

const TOKEN = 'test-sandbox-token'
const BROWSER = { id: 'b1', name: 'Work', brand: 'Chrome', os: 'macOS' }

function userContext(secret = TOKEN): string {
  const payload = Buffer.from(
    JSON.stringify({ userId: 'u', sandboxId: 's', sandboxRole: 'owner', scopes: [], iat: 0, exp: Math.floor(Date.now() / 1000) + 60 }),
  ).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
}

/** A WebSocket client with an inbox, so tests await frames in order. */
class Peer {
  ws: WebSocket
  inbox: unknown[] = []
  closed: Promise<{ code: number; reason: string }>
  private waiters: Array<() => void> = []
  opened: Promise<void>
  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers } as never)
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('ws error'))
    })
    this.closed = new Promise((resolve) => {
      this.ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })
    })
    this.ws.onmessage = (e) => {
      this.inbox.push(JSON.parse(String(e.data)))
      this.waiters.splice(0).forEach((w) => w())
    }
  }
  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame))
  }
  async next(): Promise<any> {
    while (this.inbox.length === 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    return this.inbox.shift()
  }
}

let bridge: BrowserBridge
let host: ReturnType<typeof Bun.serve>
let attachBodies: Array<Record<string, unknown>>
let releaseBodies: Array<Record<string, unknown>>
let apiStatus: number

beforeEach(() => {
  attachBodies = []
  releaseBodies = []
  apiStatus = 200
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    if (String(url).endsWith('/browser/attach')) {
      attachBodies.push(body)
      if (apiStatus !== 200) {
        return Response.json(
          { error: 'No browser is connected to Kortix.', code: 'browser_not_connected', connectUrl: 'https://kortix.com/settings/browsers' },
          { status: apiStatus },
        )
      }
      return Response.json({ attachmentId: 'att-1', browser: BROWSER })
    }
    releaseBodies.push(body)
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  bridge = createBrowserBridge({
    fetchImpl,
    cdpPort: 0,
    dialTimeoutMs: 1500,
    relay: () => ({ apiRoot: 'http://api.test/v1', token: TOKEN }),
  })
  host = Bun.serve<BridgeWsData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const prep = bridge.prepareUpgrade(req, TOKEN)
      if (!prep.ok) return prep.response
      return srv.upgrade(req, { data: { browserBridge: true } }) ? undefined : new Response('x', { status: 500 })
    },
    websocket: bridge.bridgeSocket,
  })
})

afterEach(() => {
  bridge.stop()
  host.stop(true)
})

function dial(ticket: string, ctx = userContext()): Peer {
  return new Peer(`ws://127.0.0.1:${host.port}${KORTIX_BROWSER_BRIDGE_PATH}?ticket=${ticket}`, { 'X-Kortix-User-Context': ctx })
}

/** attach() and an extension that dials as soon as the API has the ticket. */
async function attachWithExtension() {
  const pending = bridge.attach({ ask: false })
  while (attachBodies.length === 0) await Bun.sleep(5)
  const ext = dial(String(attachBodies[0]!.ticket))
  await ext.opened
  ext.send({ hello: { browser: BROWSER, tabScope: 'own' } })
  const result = await pending
  return { ext, result }
}

describe('browser bridge', () => {
  test('attach returns the browser and cdpPort once the extension dials', async () => {
    const { ext, result } = await attachWithExtension()
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ attachmentId: 'att-1', browser: BROWSER })
    expect(attachBodies[0]).toMatchObject({ ask: false })
    expect(String(attachBodies[0]!.ticket).length).toBeGreaterThanOrEqual(43)
    expect(bridge.status()).toMatchObject({ attached: true, clients: 0 })
    ext.ws.close()
  })

  test('/json/version, command passthrough, response routing and close propagation', async () => {
    const { ext, result } = await attachWithExtension()
    const port = result.body!.cdpPort as number

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    expect(version).toEqual({
      Browser: 'Kortix/Chrome',
      'Protocol-Version': '1.3',
      'User-Agent': expect.any(String),
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/kortix`,
    })
    expect(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).toEqual([])

    const cdp = new Peer(`ws://127.0.0.1:${port}/devtools/browser/kortix`)
    await cdp.opened
    expect(await ext.next()).toEqual({ c: '1', open: true })

    cdp.send({ id: 1, method: 'Target.getTargets' })
    expect(await ext.next()).toEqual({ c: '1', m: { id: 1, method: 'Target.getTargets' } })

    ext.send({ c: '1', m: { id: 1, result: { targetInfos: [] } } })
    expect(await cdp.next()).toEqual({ id: 1, result: { targetInfos: [] } })

    // A second client gets its own id, and the extension can close it.
    const cdp2 = new Peer(`ws://127.0.0.1:${port}/devtools/page/x`)
    await cdp2.opened
    expect(await ext.next()).toEqual({ c: '2', open: true })
    ext.send({ c: '2', close: true })
    expect((await cdp2.closed).code).toBe(1000)

    // A client close reaches the extension.
    cdp.ws.close()
    expect(await ext.next()).toEqual({ c: '1', close: true })

    // ping gets pong
    ext.send({ ping: 1 })
    expect(await ext.next()).toEqual({ pong: 1 })

    // Bridge closing closes every client.
    const cdp3 = new Peer(`ws://127.0.0.1:${port}/devtools/browser/kortix`)
    await cdp3.opened
    ext.ws.close()
    expect((await cdp3.closed).code).toBe(1011)
    expect(bridge.status().attached).toBe(false)
  })

  test('a wrong ticket, a bad signature and a missing ticket are refused', async () => {
    const pending = bridge.attach({})
    while (attachBodies.length === 0) await Bun.sleep(5)
    const ticket = String(attachBodies[0]!.ticket)

    const wrong = await fetch(`http://127.0.0.1:${host.port}${KORTIX_BROWSER_BRIDGE_PATH}?ticket=nope`, {
      headers: { upgrade: 'websocket', 'X-Kortix-User-Context': userContext() },
    })
    expect(wrong.status).toBe(403)
    const missing = await fetch(`http://127.0.0.1:${host.port}${KORTIX_BROWSER_BRIDGE_PATH}`, {
      headers: { upgrade: 'websocket', 'X-Kortix-User-Context': userContext() },
    })
    expect(missing.status).toBe(403)
    const forged = await fetch(`http://127.0.0.1:${host.port}${KORTIX_BROWSER_BRIDGE_PATH}?ticket=${ticket}`, {
      headers: { upgrade: 'websocket', 'X-Kortix-User-Context': userContext('other-secret') },
    })
    expect(forged.status).toBe(401)

    const ext = dial(ticket)
    await ext.opened
    ext.send({ hello: { browser: BROWSER } })
    expect((await pending).status).toBe(200)
    ext.ws.close()
  })

  test('a CDP client with no bridge closes 1011 with the exact reason', async () => {
    const { ext, result } = await attachWithExtension()
    const port = result.body!.cdpPort as number
    ext.ws.close()
    while (bridge.status().attached) await Bun.sleep(5)
    const cdp = new Peer(`ws://127.0.0.1:${port}/devtools/browser/kortix`)
    await cdp.opened.catch(() => {})
    expect(await cdp.closed).toEqual({ code: 1011, reason: NO_BROWSER_REASON })
  })

  test('API errors pass through with status and body', async () => {
    apiStatus = 404
    const result = await bridge.attach({})
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ code: 'browser_not_connected', connectUrl: 'https://kortix.com/settings/browsers' })
  })

  test('a bridge that never dials gives 502 browser_dial_failed and releases the attachment', async () => {
    const result = await bridge.attach({ browser: 'Work' })
    expect(attachBodies[0]).toMatchObject({ browser: 'Work' })
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ code: 'browser_dial_failed' })
    expect(releaseBodies).toEqual([{ attachmentId: 'att-1' }])
  })

  test('release closes the bridge and calls the API', async () => {
    const { ext } = await attachWithExtension()
    const out = await bridge.release()
    expect(out.status).toBe(204)
    expect(releaseBodies).toEqual([{ attachmentId: 'att-1' }])
    expect((await ext.closed).code).toBe(1000)
    expect(bridge.status().attached).toBe(false)
  })

  test('routes require the sandbox bearer', async () => {
    const app = createBrowserRouter({ sandboxToken: TOKEN } as never, bridge)
    expect((await app.request('/status')).status).toBe(401)
    const ok = await app.request('/status', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ attached: false, clients: 0 })
    const rel = await app.request('/release', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(rel.status).toBe(204)
  })
})
