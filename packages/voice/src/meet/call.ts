// @ts-nocheck
// (Playwright is the caller's: a host loads it, so this has no types for it.)
// The voice in any web call (Jitsi, Whereby, Teams on the web, a support line's call page...): a browser of its own opens
// the page, and the agent joins the call with its own browser tool on that browser (agent-browser --cdp <port>): the
// site's join flow is the agent's to click through, the voice knows nothing of any site. Every page of the browser has
// the voice's microphone (getUserMedia answered with the relay's speech, src/meet/page.ts botMicrophone) and its ears:
// the remote audio of the page's WebRTC connections, mixed, goes to the relay as a caller's audio (callEars). The relay
// call opens when the first remote voice comes in (someone is there to hear the greeting and its AI disclosure), in
// room mode for a group (it speaks when it is its turn) or as a one-to-one call, on the session given (the agent's own).
// Nobody heard in the call is the owner: no names come with a call's audio. Unless `trusted`, every word heard is a
// guest's (the voice's fast lane may answer; the agent never acts on it), the meeting bridge's gate (src/cascade.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { botMicrophone, callEars } from './page'

export type CallOptions = {
  /** The call's page. */
  url: string
  /** The relay's base, ws://host:port. */
  relay: string
  /** Loads Playwright (or playwright-core): the caller's, so the voice carries none. */
  playwright: () => Promise<{ chromium: any }>
  /** The browser to launch (a host's own Chromium). */
  executable?: string
  /** Hosts (host:port) the call browser may load besides public ones (a proof's call page on localhost); else none. */
  allow?: string[]
  /** The relay session the call runs on: an agent's own (default: a new one). */
  session?: string
  lang?: string
  tts?: string
  /** true: everyone's words may reach the agent (its owner said so); else every word heard is a guest's. */
  trusted?: boolean
  /** false: a call with one other person (a support line): every turn is answered. Else a group call, in room mode:
   * the voice speaks when it is addressed or its turn (one unaddressed question there was rightly let pass). */
  group?: boolean
  log?: (...a: unknown[]) => void
  /** Where it is: the page opened (the agent joins now), or the call began (the first remote voice came in and the relay
   * call opened). */
  state?: (s: 'opened' | 'in') => void
}

/** A web call: `done` says how it ended (left, ended, failed), `leave` leaves it (closes its browser), `cdp` is the port
 * its browser's CDP listens on (127.0.0.1), as Chromium bound it. */
export type WebCall = { done: Promise<string>; leave(): Promise<void>; cdp: Promise<number> }

// Loopback, private, link-local, shared and unspecified addresses: the box and its networks, never a call's.
const PRIVATE4: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]
const v4 = (a: string) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0)
const private4 = (a: string) => !/^\d+\.\d+\.\d+\.\d+$/.test(a) || PRIVATE4.some(([net, bits]) => Math.floor(v4(a) / 2 ** (32 - bits)) === Math.floor(v4(net) / 2 ** (32 - bits)))
/** An IPv6 address as its eight 16-bit groups ("::ffff:7f00:1" and "::ffff:127.0.0.1" alike); undefined when malformed. */
const groups6 = (a: string): number[] | undefined => {
  let x = a.toLowerCase().replace(/%.*$/, '')
  const tail = x.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (tail) { const n = v4(tail); x = x.slice(0, -tail.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}` }
  const [head, rest] = x.split('::')
  const h = head ? head.split(':') : [], r = rest !== undefined ? (rest ? rest.split(':') : []) : []
  const all = rest !== undefined ? [...h, ...Array(8 - h.length - r.length).fill('0'), ...r] : h
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined
  return all.map((g) => parseInt(g, 16))
}
/** A resolved address the call browser may not reach: private or special in IPv4, or in IPv6 anything outside global
 * unicast (2000::/3), and the ranges that carry an IPv4 inside (mapped, NAT64, 6to4, Teredo) by the IPv4 they carry. */
const privateAddress = (a: string): boolean => {
  if (!a.includes(':')) return private4(a)
  const g = groups6(a)
  if (!g) return true
  const inner = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return private4(inner(g[6]!, g[7]!)) // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return private4(inner(g[6]!, g[7]!)) // NAT64
  if (g[0] === 0x2002) return private4(inner(g[1]!, g[2]!)) // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true // documentation
  return (g[0]! & 0xe000) !== 0x2000 // only global unicast
}
/** A host the call browser may load: a name (never an address written as one) whose every address is public. */
export async function publicHost(hostname: string, lookup: (h: string) => Promise<string[]>): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || /^[\d.]+$/.test(h) || h.includes(':')) return false
  const addresses = await lookup(h).catch(() => [] as string[])
  return addresses.length > 0 && !addresses.some(privateAddress)
}
const resolve = async (h: string) => (await import('node:dns/promises')).lookup(h, { all: true }).then((r) => r.map((x) => x.address))

export function openCall(o: CallOptions): WebCall {
  const ended = Promise.withResolvers<string>()
  const log = o.log ?? ((...a: unknown[]) => console.error('[call]', ...a))
  const base = o.relay.replace(/\/$/, '')
  const dir = mkdtempSync(`${tmpdir()}/kortix-voice-call-`)
  let context, relay: WebSocket | undefined, page, quitting = false, outRate = 24000, inRate = 16000
  let opened: Promise<number> | undefined
  const cdp = Promise.withResolvers<number>()
  const quit = async (why: string) => {
    if (quitting) return
    quitting = true
    try { relay?.close() } catch {}
    await Promise.race([Promise.resolve(context?.close()).catch(() => {}), Bun.sleep(5000)])
    rmSync(dir, { recursive: true, force: true })
    ended.resolve(why)
  }
  // The page that hears the call is the one that speaks into it.
  const into = (fn: string, ...args: unknown[]) => void page?.evaluate(([f, a]) => (window as any)[f]?.(...a), [fn, args]).catch(() => {})
  // The relay call: opened by the first remote voice, then again 2 s after it closed (a relay restart), without a greeting.
  const connect = (greet: boolean) => new Promise<number>((ok, fail) => {
    const r = (relay = new WebSocket(`${base}/stream?provider=cascade&session=${encodeURIComponent(o.session ?? 'new')}&greet=${greet ? 1 : 0}&recall=0&lang=${o.lang ?? 'en'}${o.tts ? `&tts=${o.tts}` : ''}&room=${o.group === false ? 0 : 1}${o.trusted ? '' : '&trusted='}`))
    r.binaryType = 'arraybuffer'
    r.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) return into('__kortixPlay', Buffer.from(e.data).toString('base64'), outRate)
      const m = JSON.parse(String(e.data)) as { type: string; inRate?: number; outRate?: number; on?: boolean; role?: string; text?: string; why?: string }
      if (m.type === 'ready') (outRate = m.outRate ?? outRate), (inRate = m.inRate ?? inRate), ok(inRate)
      if (m.type === 'clear') into('__kortixClear')
      if (m.type === 'hold') into('__kortixHold', !!m.on)
      if (m.type === 'text' && m.role === 'agent' && m.text) log('said:', m.text)
      // Ended with a goodbye ("please leave the call"): the call's browser closes.
      if (m.type === 'closed' && m.why === 'goodbye') void quit('left')
    }
    r.onclose = () => void (!quitting && relay === r && setTimeout(() => !quitting && connect(false).catch(() => {}), 2000))
    r.onerror = () => fail(new Error(`relay ${o.relay} not reachable`))
  })
  const run = async () => {
    const { chromium } = await o.playwright()
    context = await chromium.launchPersistentContext(dir, {
      headless: true,
      ...(o.executable ? { executablePath: o.executable } : {}),
      // Fake devices (a box has none; the microphone is the voice's), autoplay without a gesture, and a CDP port of
      // Chromium's own choosing for the agent's browser tool (read back from DevToolsActivePort, never picked ahead).
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
      permissions: ['microphone'],
      locale: 'en-US',
    })
    context.on('close', () => void quit(quitting ? 'left' : 'ended'))
    // Every request the call browser makes goes only to a public host (callLink checked the address; a redirect, the
    // page's own navigation, a fetch or a socket could still reach the box or its network): the rest are refused.
    const allowed = new Map<string, Promise<boolean>>()
    const may = (url: string) => {
      let u: URL
      try { u = new URL(url) } catch { return Promise.resolve(false) }
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return Promise.resolve(true)
      if (o.allow?.includes(u.host)) return Promise.resolve(true)
      if (!allowed.has(u.hostname)) allowed.set(u.hostname, publicHost(u.hostname, resolve))
      return allowed.get(u.hostname)!
    }
    await context.route('**/*', async (route: any) => ((await may(route.request().url())) ? route.continue() : route.abort('blockedbyclient')))
    await context.routeWebSocket?.(/.*/, async (ws: any) => ((await may(ws.url())) ? ws.connectToServer() : ws.close()))
    await context.addInitScript(botMicrophone)
    await context.addInitScript(callEars)
    // The call is the page opened here, its sound that page's own frame: never another page of this browser (a tab the
    // agent's tool opens, a popup) nor a frame inside it (a widget, another site's iframe).
    const first = context.pages()[0] ?? (await context.newPage())
    page = first
    const main = first.mainFrame()
    // The relay's rate, asked by the ears at the first remote voice: the relay call opens then.
    await context.exposeBinding('__kortixEarRate', (source) => {
      if (source.frame !== main) return 16000
      if (!opened) opened = connect(true).then((rate) => (log('in the call'), o.state?.('in'), rate))
      return opened.catch(() => 16000)
    })
    await context.exposeBinding('__kortixHear', (source, b64: string) => {
      if (source.frame !== main || typeof b64 !== 'string' || b64.length > 200_000) return
      if (relay?.readyState === 1) relay.send(Buffer.from(b64, 'base64'))
    })
    // The CDP port Chromium bound, from its profile (the first line of DevToolsActivePort).
    for (let i = 0; i < 50; i++) {
      const port = Number((await Bun.file(`${dir}/DevToolsActivePort`).text().catch(() => '')).split('\n')[0])
      if (port > 0) { cdp.resolve(port); break }
      await Bun.sleep(100)
    }
    await first.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    log('opened', o.url)
    o.state?.('opened')
  }
  run().catch((err) => (log('failed:', err instanceof Error ? err.message : err), cdp.reject(err), quit('failed')))
  cdp.promise.catch(() => {})
  return { done: ended.promise, leave: () => quit('left'), cdp: cdp.promise }
}
