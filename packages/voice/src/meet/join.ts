// @ts-nocheck
// (Playwright is the caller's: a host loads it, so this has no types for it; bridge/meet.ts runs it with its own.)
// The voice joins a Google Meet, a note-taker bot that can speak: a browser joins the meeting as a guest under the
// voice's name, turns Meet's live captions on and reads each caption with its speaker's name; "[Ana] what do we think
// about Postgres?" goes to the relay in room mode (?room=1), so the voice knows who said what without diarization. What
// the relay says comes back as PCM and is played into the meeting through the bot's own microphone (getUserMedia is
// answered with a stream fed from here). The host admits the bot ("Ask to join"); everyone sees it, and its first
// words are the AI disclosure. The meeting's presentation goes to the relay as frames when it changes; the transcript
// (each line with its time and speaker) to `transcript`.
// Two callers: bridge/meet.ts (a box that joins meetings, its CLI), and a host's agent (src/kortix.ts: voice_join_meet),
// whose meeting runs on the agent's own session.
// Meet's page changes without notice: the caption reader looks for the live captions region by its role and label, and
// for each entry takes the short line beside the avatar as the speaker and the rest as the words.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { botMicrophone, readCaptions, watchScreen } from './page'

/** A participant's name or words with no bracket left: the relay reads "[Name] words" by its brackets, and the owner's
 * trust follows the name, so a display name "Vuka] [Ana" or a bracket in a caption could pass for a trusted speaker. */
export const unbracket = (s: string) => String(s ?? '').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim()

export type MeetOptions = {
  /** The meeting's URL. */
  meet: string
  /** The relay's base, ws://host:port. */
  relay: string
  /** Loads Playwright (or playwright-core): the caller's, so the voice carries none. */
  playwright: () => Promise<{ chromium: any }>
  /** The bot's name in the meeting (default: VOICE_NAME, else Kortix). */
  name?: string
  /** The speakers whose words may reach the agent (its host's owner, as Meet names them); the rest are heard and may be
   * answered by the voice's fast lane, never by the agent. Unset: everyone's words may. */
  trusted?: string[]
  /** The relay session the meeting runs on: an agent's own (default: a new one). */
  session?: string
  lang?: string
  /** The relay's voice for the meeting; unset, the relay's own. */
  tts?: string
  /** The agent's model for the meeting (default: VOICE_LLM, else kortix/anthropic/claude-haiku-5.5). */
  llm?: string
  /** The browser to launch (a host's own Chromium); else Chrome on Linux when installed, or Playwright's. */
  executable?: string
  channel?: string
  headed?: boolean
  /** Join signed in: a Playwright storage state (bridge/login.ts), or a Chrome profile kept on disk. */
  profile?: string
  profileDir?: string
  /** false: the presentation is never sent to the relay. */
  vision?: boolean
  /** Where the meeting's transcript goes. */
  transcript: string
  /** Screenshots of the meeting page while it runs and when it ends, for diagnosis. */
  shot?: string
  log?: (...a: unknown[]) => void
  /** Where the join is: it asked to join (the host has to admit it), or it is in the meeting. */
  state?: (s: 'asked' | 'in') => void
}

/** A meeting being joined: `done` says how it ended (left, ended, failed), `leave` leaves it. */
export type Meeting = { done: Promise<string>; leave(): Promise<void> }

export function joinMeet(o: MeetOptions): Meeting {
  const ended = Promise.withResolvers<string>()
  let leave: () => Promise<void> = async () => {}
  let shut: () => Promise<void> = async () => {}
  let stopping = false // asked to leave: what fails while the browser closes is that
  const run = async () => {
    const MEET = o.meet, RELAY = o.relay, NAME = o.name ?? process.env.VOICE_NAME ?? 'Kortix'
    const LANG = o.lang ?? 'en', TTS = o.tts ?? '', SESSION = o.session ?? 'new'
    // The agent's model for the meeting, as the browser client's default (the relay's configured one is the fastest and weakest).
    const LLM = o.llm ?? process.env.VOICE_LLM ?? 'kortix/anthropic/claude-haiku-5.5'
    const log = o.log ?? ((...a: unknown[]) => console.error('[meet]', ...a))
    const TRANSCRIPT = o.transcript
    mkdirSync(dirname(TRANSCRIPT), { recursive: true })
    const note = (who: string, text: string) => appendFileSync(TRANSCRIPT, `[${new Date().toTimeString().slice(0, 8)}] ${who}: ${text}\n`)
    let captionsTimer: ReturnType<typeof setInterval> | undefined
    // Declared before anything awaits: leave() may come at any point, the join still loading or waiting to be admitted.
    let relay: WebSocket | undefined, browser, context, page, leaving = false, inMeeting = false
    const shots: ReturnType<typeof setTimeout>[] = []
    // Real Chrome on Linux (a bot's box) when installed; elsewhere Playwright's Chromium (on a Mac real Chrome can stop at a
    // Keychain prompt). --channel=chrome|chromium to choose.
    const CHANNEL = o.channel ?? (o.executable ? undefined : process.platform === 'linux' && existsSync('/opt/google/chrome/chrome') ? 'chrome' : undefined)
    let quitting = false
    // The bot is done with this meeting: leaving it (goodbye said) or shut down (left, ended, failed). The relay is
    // never dialed again: shut() closes the relay, and its close was taken for a relay restart, every 2 s, forever.
    const over = () => leaving || quitting
    // The relay and the browser closed, the timers stopped: a browser left behind stays in the meeting as a silent bot.
    shut = async () => {
      quitting = true
      clearInterval(captionsTimer)
      for (const t of shots) clearTimeout(t)
      try { relay?.close() } catch {}
      await Promise.race([Promise.resolve().then(() => (browser ?? context)?.close()).catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
    }
    const quit = async (code = 0, why = code ? 'failed' : 'left') => {
      if (quitting) return
      stopping = true
      await shut()
      ended.resolve(why)
    }
    // Not admitted yet: the browser closes, nobody to say goodbye to.
    leave = () => (leaving || quitting ? Promise.resolve() : inMeeting ? leaveMeeting() : quit(0, 'left'))
    // A Chrome profile kept on disk (--profile-dir): the bot's Google account stays signed in across joins.
    const PROFILE_DIR = o.profileDir
    const launch = {
      headless: !o.headed,
      ...(o.executable ? { executablePath: o.executable } : {}),
      // Google Chrome when installed: Meet turned Playwright's older Chromium away on load. --channel=chromium: Playwright's.
      ...(CHANNEL && CHANNEL !== 'chromium' ? { channel: CHANNEL } : {}),
      // Fake devices: a box has no microphone and Meet joins muted when it finds none ("Microphone not found"); the bot's
      // microphone is the stream getUserMedia is answered with (botMicrophone), whatever device Meet picks.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
    }
    const PROFILE = o.profile
    if (PROFILE && !(await Bun.file(PROFILE).exists())) throw new Error(`profile ${PROFILE}: no such storage state (save one with bun bridge/login.ts --save=${PROFILE})`)
    const { chromium } = await o.playwright()
    browser = PROFILE_DIR ? undefined : await chromium.launch(launch)
    context = PROFILE_DIR
      ? await chromium.launchPersistentContext(PROFILE_DIR, { ...launch, permissions: ['microphone'], locale: 'en-US' })
      : await browser!.newContext({ permissions: ['microphone'], locale: 'en-US', ...(PROFILE ? { storageState: PROFILE } : {}) })

    // Signed in by itself: GOOGLE_EMAIL and GOOGLE_PASSWORD (from an env file, never logged) sign the profile in when it is
    // not signed in yet; Google's own pages decide (a challenge, "browser not secure") and the log says which.
    async function signIn() {
      const email = process.env.GOOGLE_EMAIL, password = process.env.GOOGLE_PASSWORD
      if (!email || !password) return
      const p = await context.newPage()
      await p.goto('https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/', { waitUntil: 'domcontentloaded' })
      await p.waitForTimeout(1500) // a signed-in profile is sent on to the account page
      if (new URL(p.url()).hostname === 'myaccount.google.com') return void (log('signed in already'), await p.close())
      // Typed as a person types (Google's page names its fields differently from release to release; the email field has
      // the focus), each step ended with Enter. Signed in = the browser leaves accounts.google.com (to the account page, a
      // recovery-options prompt, or Meet).
      try {
        await p.locator('#identifierId, input[name="identifier"], input[type="email"]').first().click({ timeout: 8000 }).catch(() => {})
        await p.keyboard.type(email, { delay: 40 })
        await p.keyboard.press('Enter')
        await p.locator('input[name="Passwd"], input[type="password"]').first().waitFor({ state: 'visible', timeout: 20_000 })
        await p.locator('input[name="Passwd"], input[type="password"]').first().click()
        await p.keyboard.type(password, { delay: 40 })
        await p.keyboard.press('Enter')
        await p.waitForURL((u) => u.hostname !== 'accounts.google.com', { timeout: 45_000 })
        log('signed in')
      } catch {
        log('sign-in did not finish:', (await p.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 160))
      }
      await p.close()
    }
    await signIn()

    // The bot's microphone: Meet asks for a microphone and gets a stream fed by an AudioContext; __kortixPlay queues PCM16
    // (base64) into it, __kortixClear drops what is queued (the relay's "clear": someone talked over the assistant).
    await context.addInitScript(botMicrophone)

    // The relay, in room mode: captions in as "[Name] words", the assistant's speech out as PCM. Opened once the bot is in
    // the meeting (its greeting, the AI disclosure, is said there); checked reachable now, before joining.
    const base = RELAY.replace(/\/$/, '')
    if (!(await fetch(base.replace(/^ws/, 'http')).then(() => true, () => false))) throw new Error(`relay ${RELAY} not reachable`)
    if (quitting) return void (await (browser ?? context).close().catch(() => {}))
    let outRate = 24000
    page = await context.newPage()
    const send = (rawWho: string, rawText: string) => {
      const who = unbracket(rawWho), text = unbracket(rawText)
      if (!text.trim() || relay?.readyState !== 1) return
      log(`[${who}] ${text}`)
      note(who, text)
      relay.send(JSON.stringify({ type: 'text', text: `[${who}] ${text}` }))
    }
    await page.exposeBinding('__kortixLine', (_source, who: string, text: string) => send(who, text))
    // A frame of the meeting's presentation, when it changed.
    await page.exposeBinding('__kortixFrame', (_source, data: string) => void (relay?.readyState === 1 && relay.send(JSON.stringify({ type: 'image', data, from: 'the presentation' }))))
    // The words so far (their caption grows): the relay starts the lookup of a question to it before the line settles.
    let peekAt = 0
    await page.exposeBinding('__kortixPeek', (_source, rawWho: string, rawWords: string) => {
      const who = unbracket(rawWho), words = unbracket(rawWords)
      if (Date.now() - peekAt < 300 || relay?.readyState !== 1 || !words.trim()) return
      peekAt = Date.now()
      relay.send(JSON.stringify({ type: 'peek', text: `[${who}] ${words}` }))
    })
    // Someone is speaking (their caption grows): the relay holds the bot's voice until their line decides.
    let talkAt = 0
    await page.exposeBinding('__kortixTalking', () => {
      if (Date.now() - talkAt < 400 || relay?.readyState !== 1) return
      talkAt = Date.now()
      relay.send(JSON.stringify({ type: 'turn', state: 'start' }))
    })
    // In English, whatever the account's language: the buttons and captions are found by their English labels.
    const meetUrl = new URL(MEET)
    meetUrl.searchParams.set('hl', 'en')
    await page.goto(meetUrl.toString(), { waitUntil: 'domcontentloaded' })

    // Join as a guest: the name, camera off, then "Ask to join" (or "Join now" when already allowed).
    // Meet renders its join screen seconds after the page loads, and Playwright's isVisible() never waits (its timeout is
    // ignored), so wait for the screen first: the name box, a join button, or Meet turning the bot away.
    const name = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first()
    const join = page.getByRole('button', { name: /ask to join|join now|^join$|switch here|join here too|rejoin/i }).first()
    const refused = page.getByText(/you can.t join this video call|not allowed to join/i).first()
    const seen = (l: ReturnType<Page['locator']>, ms: number) => l.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false)
    await Promise.race([seen(name, 45_000), seen(join, 45_000), seen(refused, 45_000)])
    // Meet turned the guest away (an anonymous browser from a datacenter IP, or a meeting closed to outsiders): say so now
    // rather than wait ten minutes for an admission that cannot come.
    if (await refused.isVisible().catch(() => false))
      throw new Error(`Meet refused to let the bot join${PROFILE ? '' : ' as an anonymous guest; join signed in with a profile (a storage state)'}`)
    if (await name.isVisible().catch(() => false)) await name.fill(NAME)
    // Meet's own buttons, whichever its page shows: a shortcut needs the focus where Meet wants it.
    const clickIf = async (label: RegExp) => {
      const b = page.getByRole('button', { name: label }).first()
      if (await b.isVisible().catch(() => false)) return void (await b.click({ timeout: 3000 }).catch(() => {}), log('clicked', String(label)))
    }
    const cameraOffMicOn = async () => (await clickIf(/turn off camera/i), await clickIf(/turn on microphone/i))
    await cameraOffMicOn()
    if (await seen(join, 15_000)) await join.click()
    else log('no join button found; is this a Meet link?')
    log('waiting to be admitted...')
    o.state?.('asked')
    await page.getByRole('button', { name: /leave call/i }).first().waitFor({ timeout: 10 * 60_000 })
    // Meet's lobby has a hang-up button too ("Please wait until a meeting host brings you into the call"; a rejoin after
    // the host left lands there): in the meeting only once its words are gone, or the greeting is said to nobody.
    const lobby = page.getByText(/brings you into the call|asking to be let in|will let you in soon|waiting for the host/i).first()
    if (await lobby.isVisible().catch(() => false)) {
      log('in the lobby: waiting for someone to let it in...')
      // Nobody let it in for half an hour: gone, browser and all (a browser left behind would stay in the lobby).
      await lobby.waitFor({ state: 'hidden', timeout: 30 * 60_000 }).catch(() => (log('nobody let it in; leaving'), quit(1)))
      // The lobby words also go when Meet gives up on the request ("No one responded to your request to join the call") or
      // turns it down: then it is out, not in (it greeted an empty page once, 2026-11-02 14:04).
      await page.waitForTimeout(1500)
      const turnedAway = page.getByText(/no one responded to your request|you can.t join this (video )?call|denied your request|you.ve been removed|return to home screen/i).first()
      if (await turnedAway.isVisible().catch(() => false)) {
        log('not let in:', (await turnedAway.innerText().catch(() => '')).slice(0, 80))
        await quit(1)
      }
    }
    log('in the meeting')
    inMeeting = true
    o.state?.('in')
    // The meeting's code (abc-defg-hij): a restarted relay reloads this meeting's transcripts, and no other's.
    const MEETING = new URL(MEET).pathname.split('/').filter(Boolean).at(-1)?.replace(/[^\w-]/g, '') || 'meeting'
    // A relay call; when it closes (the relay restarted) and the bot is still in the meeting, a new one 2 s later, without
    // a second greeting.
    /** Asked to leave: Meet's "Leave call", then the bridge ends (never a reconnect). */
    async function leaveMeeting() {
      if (leaving) return
      leaving = true
      log('asked to leave: leaving the meeting')
      await page.getByRole('button', { name: /leave call/i }).first().click({ timeout: 5000 }).catch(() => {})
      await quit(0)
    }
    const connect = (greet: boolean) => {
      const r = (relay = new WebSocket(`${base}/stream?provider=cascade&session=${encodeURIComponent(SESSION)}&greet=${greet ? 1 : 0}&recall=0&lang=${LANG}${TTS ? `&tts=${TTS}` : ''}&room=1${o.trusted ? `&trusted=${encodeURIComponent(o.trusted.join(','))}` : ''}&meeting=${encodeURIComponent(MEETING)}&llm=${encodeURIComponent(LLM)}`))
      r.binaryType = 'arraybuffer'
      r.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) return void page.evaluate(([b64, rate]) => (window as unknown as { __kortixPlay(b: string, r: number): void }).__kortixPlay(b64, rate), [Buffer.from(e.data).toString('base64'), outRate] as const).catch(() => {})
        const m = JSON.parse(String(e.data)) as { type: string; outRate?: number; role?: string; text?: string }
        if (m.type === 'ready' && m.outRate) outRate = m.outRate
        if (m.type === 'clear') void page.evaluate(() => (window as unknown as { __kortixClear(): void }).__kortixClear()).catch(() => {})
        if (m.type === 'hold') void page.evaluate((on) => (window as unknown as { __kortixHold(on: boolean): void }).__kortixHold(on), !!(m as { on?: boolean }).on).catch(() => {})
        if (m.type === 'text' && m.role === 'agent' && m.text) log('said:', m.text), note(NAME, m.text)
        if (m.type === 'text' && m.role === 'screen' && m.text) log('saw:', m.text), note('Screen', m.text)
        // The relay wants the frame of now (a screenshot, a look at the presentation): the next frame goes out at once.
        if (m.type === 'snap') void page.evaluate(() => (window as unknown as { __kortixSnapNow?(): void }).__kortixSnapNow?.()).catch(() => {})
        // The relay ended the call with a goodbye (asked to leave: "Kortix, please leave the call now." got "[end] Bye."): the
        // bot leaves the meeting. Before, the socket's close was taken for a relay restart and it rejoined 2 s later.
        if (m.type === 'closed' && (m as { why?: string }).why === 'goodbye') void leaveMeeting()
      }
      r.onclose = () => void (!over() && relay === r && (log('relay closed; reconnecting'), setTimeout(again, 2000)))
      return new Promise<void>((ok, fail) => ((r.onopen = () => ok()), (r.onerror = () => fail(new Error(`relay ${RELAY} not reachable`)))))
    }
    // Back to the relay after it closed: tried every 2 s until it answers (a restart can take longer than one try).
    const again = () => void (!over() && connect(false).then(() => log('relay back'), () => (!over() && (log('relay not back yet; trying again'), setTimeout(again, 2000)))))
    await connect(true)

    await cameraOffMicOn() // in the call too: Meet may have kept either as it was
    // Live captions on: the shortcut with the focus on the call, else Meet's captions button and the option it opens.
    await page.mouse.click(640, 300).catch(() => {})
    await page.keyboard.press('c').catch(() => {}) // live captions on (Meet's shortcut)
    // The shortcut does nothing with focus in a dialog or the chat: then Meet's own button.
    const captions = page.locator('[role="region"][aria-label*="aption" i]')
    await page.waitForTimeout(1500)
    if (!(await captions.count())) await clickIf(/turn on captions|^captions/i)
    await page.waitForTimeout(1200)
    if (!(await captions.count())) {
      await clickIf(/captions and translation/i)
      await page.waitForTimeout(1200)
      const on = page.getByText(/turn on captions|show captions|^captions$/i).first()
      if (await on.isVisible().catch(() => false)) await on.click({ timeout: 3000 }).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(1200)
    }
    log(await captions.count() ? 'captions on' : 'captions not found yet: Meet may still be loading them, or its page changed')

    // Captions: each entry is a speaker's turn, its words growing as they speak. A line goes out once its words stop
    // changing (1.2 s; 0.6 s after a question mark) or the next entry starts; the bot's own captions ("You", its name) are skipped.
    await page.evaluate(readCaptions, [NAME] as const)
    if (o.vision !== false) await page.evaluate(watchScreen, [8000] as const)
    log('listening (captions); transcript:', TRANSCRIPT)
    let captionsTriedAt = 0
    captionsTimer = setInterval(async () => {
      await clickIf(/turn on microphone/i) // unmuted: Meet may mute a newcomer
      if ((await captions.count().catch(() => 1)) || Date.now() - captionsTriedAt < 15_000) return
      captionsTriedAt = Date.now()
      log('captions off: turning them on')
      await page.mouse.click(640, 300).catch(() => {})
      await page.keyboard.press('c').catch(() => {})
      await page.waitForTimeout(1500)
      if (await captions.count().catch(() => 0)) return void log('captions on')
      await clickIf(/turn on captions|^captions/i)
      await clickIf(/captions and translation/i)
      await page.waitForTimeout(1200)
      const on = page.getByText(/turn on captions|show captions|^captions$/i).first()
      if (await on.isVisible().catch(() => false)) await on.click({ timeout: 3000 }).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
      if (await captions.count().catch(() => 0)) log('captions on')
    }, 5000)
    const SHOT = o.shot
    if (SHOT) for (let i = 0; i < 9; i++) shots.push(setTimeout(async () => {
      const d = await page.evaluate(() => ({
        regions: [...document.querySelectorAll('[role="region"], [aria-live]')].map((e) => e.getAttribute('aria-label') || e.getAttribute('aria-live') || '?').slice(0, 8),
        buttons: [...document.querySelectorAll('button, [role="button"]')].map((b) => b.getAttribute('aria-label') || '').filter((l) => /caption|subtit/i.test(l)).slice(0, 4),
      })).catch(() => undefined)
      log('page:', JSON.stringify(d))
      await page.screenshot({ path: SHOT }).catch(() => {})
    }, (i + 1) * 20_000))

    // The call is over when its hang-up button is gone for good: Meet re-renders its controls (after the lobby, a layout
    // change), and a button gone for a moment is not the end of the call (the bot left a live meeting without a word,
    // 2026-11-02 13:58). Why it ended is logged, with the page as it was.
    const hangUp = page.getByRole('button', { name: /leave call/i }).first()
    for (;;) {
      await hangUp.waitFor({ state: 'detached', timeout: 24 * 3600_000 }).catch(() => {})
      if (await hangUp.waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false)) continue
      break
    }
    const why = await page.locator('body').innerText({ timeout: 2000 }).then((t) => t.replace(/\s+/g, ' ').slice(0, 160), () => '(page gone)')
    if (SHOT) await page.screenshot({ path: SHOT }).catch(() => {})
    log('the call ended:', why)
    leaving = true
    await quit(0, 'ended')

  }
  // A join that failed (Meet turned the guest away, the relay is gone): closed, then reported.
  run().catch(async (err) => {
    if (stopping) return
    await shut()
    ended.reject(err)
  })
  return { done: ended.promise, leave: () => leave() }
}
