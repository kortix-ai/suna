// @ts-nocheck
// (Browser code, run in the meeting's page: no DOM types here.)
// The code the Meet bridge runs inside the meeting's page (src/meet/join.ts), and that bridge/selftest.ts runs against a
// page shaped like Meet's: each function is self-contained, as Playwright sends it to the browser as text.

/** The bot's microphone: getUserMedia answers with a stream fed by an AudioContext; __kortixPlay queues PCM16 (base64)
 * into it, __kortixClear drops what is queued (the relay's "clear": someone talked over the assistant), __kortixHold
 * stops it within a beat and goes on from there (the relay's "hold": someone is saying something over it). A hold takes
 * the voice off the stream and keeps what is left of each piece, from where it stopped, while the stream carries
 * silence: a suspended AudioContext kept its last milliseconds in the stream, and the clear after it let them out as a
 * blip ~2.3 s after she was talked over (bridge/holdclear-proof.ts: 7 of 12 clears; the Meet e2e: 3 of 12 runs). */
export const botMicrophone = () => {
  const ac = new AudioContext({ sampleRate: 24000 })
  const dest = ac.createMediaStreamDestination()
  let at = 0
  type Piece = { src: AudioBufferSourceNode; buf: AudioBuffer; begins: number } // begins: when its first sample plays
  let playing: Piece[] = []
  let held: { buf: AudioBuffer; from: number }[] | undefined // on hold: what is left of each piece, in order
  const w = window as unknown as Record<string, unknown>
  const play = (buf: AudioBuffer, from = 0) => {
    const src = ac.createBufferSource()
    src.buffer = buf
    src.connect(dest)
    at = Math.max(at, ac.currentTime + 0.02)
    src.start(at, from)
    const piece = { src, buf, begins: at - from }
    at += buf.duration - from
    playing.push(piece)
    src.onended = () => (playing = playing.filter((p) => p !== piece))
  }
  const stopAll = () => {
    for (const p of playing) try { p.src.stop() } catch {}
    playing = []
    at = 0
  }
  w.__kortixPlay = (b64: string, rate: number) => {
    const bin = atob(b64)
    const n = bin.length >> 1
    const buf = ac.createBuffer(1, n, rate)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < n; i++) ch[i] = (((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16) >> 16) / 32768
    if (held) held.push({ buf, from: 0 })
    else play(buf)
  }
  w.__kortixClear = () => {
    stopAll()
    held = undefined
    void ac.resume()
  }
  w.__kortixHold = (on: boolean) => {
    if (on && !held) {
      const now = ac.currentTime
      held = [...playing].sort((a, b) => a.begins - b.begins).map((p) => ({ buf: p.buf, from: Math.max(0, now - p.begins) })).filter((x) => x.from < x.buf.duration)
      stopAll()
    } else if (!on && held) {
      const rest = held
      held = undefined
      for (const x of rest) play(x.buf, x.from)
    }
  }
  if (!navigator.mediaDevices) return // not a secure page: no microphone to answer for
  // No camera, ever: no video device is listed and a camera request fails as a missing camera does (Meet then shows
  // the account's avatar); the microphone is the bot's voice.
  const devices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async () => (await devices()).filter((d) => d.kind !== 'videoinput')
  navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
    if (!c?.audio) throw new DOMException('Requested device not found', 'NotFoundError')
    void ac.resume()
    return new MediaStream(dest.stream.getAudioTracks())
  }
}

/** Meet's live captions: each entry is a speaker's turn, its words growing as they speak. A line goes out (via the
 * page's __kortixLine binding) once its words stop changing for 1.2 s (0.6 s after a question mark) or the next entry starts; while they grow,
 * __kortixTalking says someone is speaking (the bot's voice holds); the bot's own captions ("You", its name) are skipped. */
export const readCaptions = ([self]) => {
  const w = window as unknown as { __kortixLine(who: string, text: string): void }
  const sent = new WeakMap<Element, string>(), seen = new WeakMap<Element, string>(), timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const region = () => document.querySelector('[role="region"][aria-label*="aption" i]') ?? document.querySelector('[aria-live][aria-label*="aption" i]')
  // Meet's caption rows, and in each the speaker and the words, by the names other caption readers find them by (2026).
  const ROW = 'div[jsname="dsyhDe"], div.CNusmb, div.TBMuR', WHO = 'div.KcIKyf, div.zs7s8d, span[jsname="YSxPC"]', WORDS = 'div.bh44bd, span[jsname="tgaKEf"], div.iTTPOb'
  const parse = (entry: Element) => {
    const said = entry.querySelector(WORDS)
    if (said) {
      const words = (said.textContent ?? '').replace(/\s+/g, ' ').trim()
      return words ? { who: (entry.querySelector(WHO)?.textContent ?? '').trim() || 'Someone', words } : undefined
    }
    // None of those: Meet's names changed. Each child of the region is a row.
    const texts = [...entry.querySelectorAll('div, span')].map((e) => (e.children.length ? '' : (e.textContent ?? '').trim())).filter(Boolean)
    if (!texts.length) return
    // The speaker is the short first line beside the avatar (as other caption readers take it); when Meet's layout
    // shows none, the words still go out, from Someone.
    const named = texts.length >= 2 && texts[0]!.split(' ').length <= 4
    const who = named ? texts[0]! : 'Someone', words = (named ? texts.slice(1) : texts).join(' ').replace(/\s+/g, ' ').trim()
    return words ? { who, words } : undefined
  }
  // Her name, or a sound-alike (Claudia for Klaudia): a question to her goes out sooner.
  const callsMe = (t: string) => t.toLowerCase().replace(/c/g, 'k').includes(String(self).toLowerCase().replace(/c/g, 'k'))
  const flush = (entry: Element) => {
    const p = parse(entry)
    if (!p || p.who === 'You' || p.who === self) return
    // Compared by words, punctuation aside: Meet re-punctuates a caption as it grows ("Yo!" -> "Yo, what can you do?").
    const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean)
    const before = bare(sent.get(entry) ?? ''), now = p.words.split(/\s+/)
    const extends_ = before.length && before.every((w, i) => bare(now[i] ?? '')[0] === w)
    const fresh = !before.length ? p.words : extends_ ? now.slice(before.length).join(' ').trim() : bare(p.words).join(' ') === before.join(' ') ? '' : p.words
    if (fresh) w.__kortixLine(p.who, fresh), sent.set(entry, p.words)
  }
  const observer = new MutationObserver(() => {
    const r = region()
    if (!r) return
    // The bot's own captions are not turns: the live entry is the last one of someone else (Ben still speaking while
    // the bot's caption appears after his must not cut his line).
    const rows = r.querySelectorAll(ROW)
    // Buttons in the captions panel ("Jump to bottom") are not captions.
    const control = (e: Element) => e.matches('button, [role="button"]') || (!!e.querySelector('button') && !e.querySelector('img'))
    const entries = [...(rows.length ? rows : r.children)].filter((e) => !control(e)).filter((e) => { const p = parse(e); return p && p.who !== 'You' && p.who !== self })
    entries.forEach((entry, i) => {
      if (i < entries.length - 1) return flush(entry) // an earlier entry: its turn is over
      const words = parse(entry)!.words
      if (words !== seen.get(entry) && words !== sent.get(entry)) {
        seen.set(entry, words)
        const x = w as unknown as { __kortixTalking?(who: string): void; __kortixPeek?(who: string, words: string): void }
        x.__kortixTalking?.(parse(entry)!.who)
        x.__kortixPeek?.(parse(entry)!.who, words) // the words so far: the relay may start their lookup
      }
      clearTimeout(timers.get(entry))
      // A caption ending in a question mark is one Meet's recognizer has finished: it goes sooner (the answer starts
      // ~0.6 s earlier); other words wait 1.2 s, as a sentence may go on.
      timers.set(entry, setTimeout(() => flush(entry), /\?$/.test(words) ? (callsMe(words) ? 400 : 900) : 1200))
    })
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
}

/** The meeting's shared screen: the largest video playing (a presentation fills the stage). A frame goes out (via the
 * page's __kortixFrame binding, a JPEG in base64) when the picture changed (its thumbnail differs), at most every
 * `every` ms, and once a minute regardless; the relay reads its words and looks again only when they changed. */
export const watchScreen = ([every]) => {
  const w = window as unknown as { __kortixFrame(b64: string): void }
  // Whether the picture moved: a 64x36 grey thumbnail, moved when 12 of its pixels changed by 24 levels or more. The
  // mean change of a 32x18 one (moved at 4 levels) never saw one text slide turn into another: a slide is mostly the same
  // white, and its words are a few grey pixels at that size. In the meeting meta e2e (2026-11-02) no slide change was
  // sent as one; each was read only at the minute's refresh or a snap, and a Roadmap slide up 12 s was never read. A
  // cursor moving is a pixel or two.
  const W = 64, H = 36
  const thumb = document.createElement('canvas')
  thumb.width = W
  thumb.height = H
  const tc = thumb.getContext('2d', { willReadFrequently: true })!
  let last: Uint8Array | undefined, sentAt = -Infinity
  // Asked for the frame of now (the relay's snap): the next tick sends it whether or not the picture moved.
  ;(window as unknown as { __kortixSnapNow(): void }).__kortixSnapNow = () => void ((sentAt = -Infinity), (last = undefined))
  setInterval(() => {
    const area = (v: HTMLVideoElement) => v.clientWidth * v.clientHeight
    const v = [...document.querySelectorAll('video')].filter((x) => x.readyState >= 2 && x.videoWidth >= 640).sort((a, b) => area(b) - area(a))[0]
    if (!v || performance.now() - sentAt < every) return
    tc.drawImage(v, 0, 0, W, H)
    const px = tc.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) g[i] = (px[4 * i]! + px[4 * i + 1]! + px[4 * i + 2]!) / 3
    const moved = !last || g.reduce((a, x, i) => a + (Math.abs(x - last![i]!) >= 24 ? 1 : 0), 0) >= 12
    if (!moved && performance.now() - sentAt < 60_000) return
    last = g
    sentAt = performance.now()
    const c = document.createElement('canvas')
    c.width = Math.min(1280, v.videoWidth)
    c.height = Math.round((v.videoHeight * c.width) / v.videoWidth)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    w.__kortixFrame(c.toDataURL('image/jpeg', 0.7).split(',')[1]!)
  }, 1000)
}

/** The call, as the voice hears it: every remote audio track of the page's WebRTC connections (the other people's
 * voices), mixed and resampled to the relay's rate (__kortixEarRate), goes out as PCM16 (base64) in 64 ms pieces through
 * __kortixHear, silence included (the relay finds the end of a turn in it). Any site that calls over WebRTC: nothing of
 * the site's page is read, only what its connections receive. Chrome gives WebAudio a remote track's sound only while a
 * media element plays it too: each one also plays in a muted element. */
export const callEars = () => {
  const w = window as unknown as Record<string, any>
  const Native = w.RTCPeerConnection
  if (!Native) return
  let ready: Promise<{ ac: AudioContext; mix: GainNode }> | undefined
  const start = () => (ready ??= (async () => {
    const rate = (await w.__kortixEarRate?.()) || 16000
    const ac = new AudioContext({ sampleRate: rate })
    const mix = ac.createGain()
    const proc = ac.createScriptProcessor(1024, 1, 1)
    proc.onaudioprocess = (e: { inputBuffer: AudioBuffer }) => {
      const f = e.inputBuffer.getChannelData(0)
      const pcm = new Uint8Array(f.length * 2)
      for (let i = 0; i < f.length; i++) {
        const s = Math.round(Math.max(-1, Math.min(1, f[i]!)) * 32767)
        pcm[2 * i] = s & 255
        pcm[2 * i + 1] = (s >> 8) & 255
      }
      let bin = ''
      for (let i = 0; i < pcm.length; i += 4096) bin += String.fromCharCode(...pcm.subarray(i, i + 4096))
      w.__kortixHear?.(btoa(bin))
    }
    mix.connect(proc)
    proc.connect(ac.destination) // a processor runs only while connected; what it writes out is silence
    void ac.resume()
    return { ac, mix }
  })())
  const heard = new Set<string>()
  const hear = (track: MediaStreamTrack) => {
    if (track.kind !== 'audio' || heard.has(track.id)) return
    heard.add(track.id)
    const stream = new MediaStream([track])
    const el = new Audio()
    el.muted = true
    el.srcObject = stream
    void el.play().catch(() => {})
    void start().then(({ ac, mix }) => ac.createMediaStreamSource(stream).connect(mix))
  }
  // Each connection the page makes: its remote tracks are heard as they come.
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    const pc = new Native(...args)
    pc.addEventListener('track', (e: { track: MediaStreamTrack }) => hear(e.track))
    return pc
  }
  Wrapped.prototype = Native.prototype
  Object.setPrototypeOf(Wrapped, Native) // its statics (generateCertificate)
  w.RTCPeerConnection = Wrapped
  if (w.webkitRTCPeerConnection) w.webkitRTCPeerConnection = Wrapped
}
