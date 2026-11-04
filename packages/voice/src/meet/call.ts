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
  /** The CDP port the agent's browser tool drives the call's browser on (127.0.0.1 only). */
  cdp: number
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

/** A web call: `done` says how it ended (left, ended, failed), `leave` leaves it (closes its browser). */
export type WebCall = { done: Promise<string>; leave(): Promise<void> }

/** A free port on 127.0.0.1, for the call browser's CDP. */
export function freePort(): number {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = s.port
  s.stop(true)
  return port
}

export function openCall(o: CallOptions): WebCall {
  const ended = Promise.withResolvers<string>()
  const log = o.log ?? ((...a: unknown[]) => console.error('[call]', ...a))
  const base = o.relay.replace(/\/$/, '')
  const dir = mkdtempSync(`${tmpdir()}/kortix-voice-call-`)
  let context, relay: WebSocket | undefined, page, quitting = false, outRate = 24000, inRate = 16000
  let opened: Promise<number> | undefined
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
      // Fake devices (a box has none; the microphone is the voice's), autoplay without a gesture, and the CDP port the
      // agent's browser tool connects to.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled', `--remote-debugging-port=${o.cdp}`, '--remote-debugging-address=127.0.0.1'],
      permissions: ['microphone'],
      locale: 'en-US',
    })
    context.on('close', () => void quit(quitting ? 'left' : 'ended'))
    await context.addInitScript(botMicrophone)
    await context.addInitScript(callEars)
    // The relay's rate, asked by the ears at the first remote voice: the relay call opens then.
    await context.exposeBinding('__kortixEarRate', (source) => {
      page = source.page
      if (!opened) opened = connect(true).then((rate) => (log('in the call'), o.state?.('in'), rate))
      return opened.catch(() => 16000)
    })
    await context.exposeBinding('__kortixHear', (source, b64: string) => {
      if (source.page !== page) return // one call's sound: the page that started it
      if (relay?.readyState === 1) relay.send(Buffer.from(b64, 'base64'))
    })
    const first = context.pages()[0] ?? (await context.newPage())
    page = first
    await first.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    log('opened', o.url, 'cdp', o.cdp)
    o.state?.('opened')
  }
  run().catch((err) => (log('failed:', err instanceof Error ? err.message : err), quit('failed')))
  return { done: ended.promise, leave: () => quit('left') }
}
