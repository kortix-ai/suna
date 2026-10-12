/**
 * Kortix Browser, sandbox side (protocol: .agents/skills/kortix-browser/references/protocol.md §5, §6, §8).
 *
 * The user's Chrome extension dials a bridge websocket into this daemon (the
 * API preview proxy forwards it). A loopback CDP listener on 127.0.0.1:9333
 * lets `agent-browser --cdp 9333` talk to that Chrome: every CDP client gets an
 * id, and its commands and the extension's replies travel as `{c, m}` frames
 * over the one bridge socket.
 *
 * One bridge per sandbox. A new valid dial replaces the old one.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Server, ServerWebSocket } from 'bun'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '@/lib/kortix-api/kortix-user-context'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { logger } from '@/lib/log/logger'

export const KORTIX_BROWSER_BRIDGE_PATH = '/kortix/browser/bridge'
export const CDP_PORT = 9333
export const NO_BROWSER_REASON = 'No browser attached. Run: kortix browser use'

const DIAL_TIMEOUT_MS = 30_000
const PING_MS = 20_000
const STALE_MS = 60_000

const USER_CONTEXT_QUERY_PARAM = '__kortix_user_context'

export interface BridgeWsData {
  browserBridge: true
}
export interface CdpWsData {
  id?: string
}

export function isBridgeWsData(data: unknown): data is BridgeWsData {
  return typeof data === 'object' && data !== null && (data as BridgeWsData).browserBridge === true
}

type Json = Record<string, unknown>
export interface BrowserResult {
  status: number
  body?: Json
}

export interface BridgeOptions {
  fetchImpl?: typeof fetch
  /** CDP listener port. Tests pass 0 for an ephemeral port. */
  cdpPort?: number
  dialTimeoutMs?: number
  pingMs?: number
  /** Control-plane context; defaults to the sandbox env. */
  relay?: () => { apiRoot: string; token: string } | null
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function errorBody(error: string, code: string): Json {
  return { error, code }
}

async function readBody(res: Response): Promise<Json> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed as Json
  } catch {}
  return { error: text || `HTTP ${res.status}` }
}

export function createBrowserBridge(opts: BridgeOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const dialTimeoutMs = opts.dialTimeoutMs ?? DIAL_TIMEOUT_MS
  const pingMs = opts.pingMs ?? PING_MS
  const relay = opts.relay ?? sandboxRelayContext

  let attachmentId: string | null = null
  let ticket: string | null = null
  let browser: Json | null = null
  let bridge: ServerWebSocket<BridgeWsData> | null = null
  let lastFrameAt = 0
  let pinger: ReturnType<typeof setInterval> | null = null
  let waiter: ((ok: boolean) => void) | null = null
  // The extension may dial before the API answers /browser/attach (it dials as
  // soon as consent is granted), so the hello can land before attach() waits.
  let helloSeen = false
  const clients = new Map<string, ServerWebSocket<CdpWsData>>()
  let nextClientId = 1
  let cdpServer: Server<CdpWsData> | null = null

  const sendBridge = (frame: Json) => {
    try { bridge?.send(JSON.stringify(frame)) } catch {}
  }

  function cdpListener(): Server<CdpWsData> {
    if (cdpServer) return cdpServer
    cdpServer = Bun.serve<CdpWsData>({
      port: opts.cdpPort ?? CDP_PORT,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket' && url.pathname.startsWith('/devtools/')) {
          if (srv.upgrade(req, { data: {} })) return undefined
          return new Response('websocket upgrade failed', { status: 500 })
        }
        if (url.pathname === '/json/version') {
          if (!bridge) return Response.json({ error: NO_BROWSER_REASON }, { status: 503 })
          const brand = typeof browser?.brand === 'string' ? browser.brand : 'Chrome'
          return Response.json({
            Browser: `Kortix/${brand}`,
            'Protocol-Version': '1.3',
            'User-Agent': `Kortix Browser (${brand})`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/kortix`,
          })
        }
        if (url.pathname === '/json' || url.pathname === '/json/list') return Response.json([])
        return new Response('not found', { status: 404 })
      },
      websocket: {
        open(ws) {
          if (!bridge) {
            ws.close(1011, NO_BROWSER_REASON)
            return
          }
          const id = String(nextClientId++)
          ws.data.id = id
          clients.set(id, ws)
          sendBridge({ c: id, open: true })
        },
        message(ws, message) {
          const id = ws.data.id
          if (!id || !bridge) return
          try {
            sendBridge({ c: id, m: JSON.parse(typeof message === 'string' ? message : message.toString()) })
          } catch {
            // Not JSON: not a CDP command. Drop it.
          }
        },
        close(ws) {
          const id = ws.data.id
          if (!id || clients.get(id) !== ws) return
          clients.delete(id)
          sendBridge({ c: id, close: true })
        },
      },
    })
    return cdpServer
  }

  /** Forget the attachment. Closes every CDP client; the listener stays up so
   *  a late client reads NO_BROWSER_REASON instead of a refused connection. */
  function reset(closeBridge: boolean, reason: string) {
    const old = bridge
    bridge = null
    attachmentId = null
    ticket = null
    browser = null
    helloSeen = false
    if (pinger) clearInterval(pinger)
    pinger = null
    for (const ws of clients.values()) {
      try { ws.close(1011, reason) } catch {}
    }
    clients.clear()
    if (closeBridge && old) {
      try { old.close(1000, reason) } catch {}
    }
  }

  async function callApi(path: string, body: Json): Promise<Response | null> {
    const ctx = relay()
    if (!ctx) return null
    return fetchImpl(`${ctx.apiRoot}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function waitForDial(): Promise<boolean> {
    if (helloSeen) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiter = null
        resolve(false)
      }, dialTimeoutMs)
      waiter = (ok) => {
        clearTimeout(timer)
        waiter = null
        resolve(ok)
      }
    })
  }

  async function attach(input: { browser?: string; ask?: boolean }): Promise<BrowserResult> {
    if (!relay()) {
      return {
        status: 503,
        body: errorBody('This sandbox has no Kortix control plane, so it cannot reach a browser.', 'browser_unavailable'),
      }
    }
    try {
      cdpListener()
    } catch (err) {
      return {
        status: 500,
        body: errorBody(`The CDP port ${CDP_PORT} is not available: ${(err as Error).message}`, 'browser_cdp_unavailable'),
      }
    }
    const myTicket = randomBytes(32).toString('base64url')
    ticket = myTicket
    helloSeen = false
    const payload: Json = { ticket: myTicket, ask: input.ask === true }
    if (input.browser) payload.browser = input.browser
    let res: Response | null
    try {
      res = await callApi('/browser/attach', payload)
    } catch (err) {
      if (ticket === myTicket && !bridge) ticket = null
      return { status: 502, body: errorBody(`Could not reach Kortix: ${(err as Error).message}`, 'browser_api_unreachable') }
    }
    if (!res) return { status: 503, body: errorBody('This sandbox has no Kortix control plane.', 'browser_unavailable') }
    const data = await readBody(res)
    if (!res.ok) {
      if (ticket === myTicket && !bridge) ticket = null
      return { status: res.status, body: data }
    }
    const id = String(data.attachmentId ?? '')
    attachmentId = id
    const dialed = await waitForDial()
    if (!dialed || attachmentId !== id) {
      if (attachmentId === id) {
        reset(true, 'dial timeout')
        await callApi('/browser/release', { attachmentId: id }).catch(() => null)
      }
      return {
        status: 502,
        body: errorBody(
          `Chrome was told to connect but did not dial in within ${Math.round(dialTimeoutMs / 1000)} s. Check that Chrome is open and the Kortix extension is signed in.`,
          'browser_dial_failed',
        ),
      }
    }
    return {
      status: 200,
      body: { attachmentId: id, browser: browser ?? (data.browser as Json) ?? null, cdpPort: cdpServer?.port ?? CDP_PORT },
    }
  }

  async function release(): Promise<BrowserResult> {
    const id = attachmentId
    reset(true, 'released')
    if (id) await callApi('/browser/release', { attachmentId: id }).catch(() => null)
    return { status: 204 }
  }

  function status() {
    return { attached: bridge !== null, browser, clients: clients.size, cdpPort: cdpServer?.port ?? CDP_PORT }
  }

  /** Validate a bridge dial: signed user context plus the current ticket. */
  function prepareUpgrade(req: Request, sandboxToken: string | undefined): { ok: true } | { ok: false; response: Response } {
    const deny = (status: number, body: Json) => ({ ok: false as const, response: Response.json(body, { status }) })
    if (!sandboxToken) return deny(503, { error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' })
    const url = new URL(req.url)
    const header = req.headers.get(KORTIX_USER_CONTEXT_HEADER) ?? url.searchParams.get(USER_CONTEXT_QUERY_PARAM)
    const auth = verifyKortixUserContext(header, sandboxToken)
    if (!auth.ok) return deny(401, { error: 'unauthorized', reason: auth.reason })
    const presented = url.searchParams.get('ticket')
    if (!ticket || !presented || !safeEqual(presented, ticket)) {
      return deny(403, { error: 'invalid or expired browser ticket', code: 'browser_bad_ticket' })
    }
    return { ok: true }
  }

  const bridgeSocket = {
    open(ws: ServerWebSocket<BridgeWsData>) {
      const old = bridge
      bridge = ws
      lastFrameAt = Date.now()
      if (old && old !== ws) {
        for (const c of clients.values()) {
          try { c.close(1011, 'Browser connection replaced') } catch {}
        }
        clients.clear()
        try { old.close(1000, 'replaced') } catch {}
      }
      if (pinger) clearInterval(pinger)
      pinger = setInterval(() => {
        if (Date.now() - lastFrameAt > STALE_MS) {
          logger.warn('[browser] bridge went silent; closing')
          try { ws.close(1001, 'ping timeout') } catch {}
          return
        }
        sendBridge({ ping: 1 })
      }, pingMs)
    },
    message(ws: ServerWebSocket<BridgeWsData>, message: string | Buffer) {
      if (ws !== bridge) return
      lastFrameAt = Date.now()
      let frame: Json
      try {
        frame = JSON.parse(typeof message === 'string' ? message : message.toString())
      } catch {
        return
      }
      if (frame.hello && typeof frame.hello === 'object') {
        const hello = frame.hello as Json
        if (hello.browser && typeof hello.browser === 'object') browser = hello.browser as Json
        helloSeen = true
        waiter?.(true)
        return
      }
      if (frame.ping) return sendBridge({ pong: 1 })
      if (frame.pong) return
      const id = typeof frame.c === 'string' ? frame.c : null
      const client = id ? clients.get(id) : undefined
      if (!id || !client) return
      if (frame.close) {
        clients.delete(id)
        try { client.close(1000, 'closed by browser') } catch {}
      } else if (frame.m !== undefined) {
        try { client.send(JSON.stringify(frame.m)) } catch {}
      }
    },
    close(ws: ServerWebSocket<BridgeWsData>) {
      if (ws !== bridge) return
      reset(false, 'Browser disconnected')
      waiter?.(false)
    },
  }

  return {
    attach,
    release,
    status,
    prepareUpgrade,
    bridgeSocket,
    /** Test hook: stop the CDP listener. */
    stop() {
      reset(true, 'stopped')
      cdpServer?.stop(true)
      cdpServer = null
    },
  }
}

export type BrowserBridge = ReturnType<typeof createBrowserBridge>

/** The daemon's one bridge. */
export const browserBridge: BrowserBridge = createBrowserBridge()
