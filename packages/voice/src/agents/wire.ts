// The agent session over the OpenCode-shaped wire (VOICE_AGENT=wire, the default backend; src/brain.ts picks one).
// In a Kortix box that is kortixd (:8000), which serves it for the pi harness (every box since 2026-10-23) and for
// legacy OpenCode alike: the voice shares the session's tools, files and history. Locally it can be `opencode serve`
// or kortixd.
import { createHmac } from 'node:crypto'
import type { Bus, Recall, TurnEvents } from '../agent'
import { chargeAgent } from '../cost'
import { threadNote, type ThreadSnapshot } from '../thread'
export type { Bus, Recall, TurnEvents }

const url = (process.env.AGENT_URL ?? process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').replace(/\/$/, '')
const [providerID, ...rest] = (process.env.BRAIN_MODEL ?? '').split('/')
const model = providerID && rest.length ? { providerID, modelID: rest.join('/') } : undefined

// kortixd accepts only requests carrying X-Kortix-User-Context: a base64url JSON claim and its
// HMAC-SHA256 under the box's KORTIX_TOKEN (apps/kortix-sandbox-agent-server kortix-user-context.ts).
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const secret = process.env.KORTIX_TOKEN
  if (!secret) return extra
  const now = Math.floor(Date.now() / 1000)
  const claim = { userId: 'voice', sandboxId: process.env.KORTIX_SANDBOX_ID ?? 'local', sandboxRole: 'owner', scopes: [], iat: now, exp: now + 300 }
  const payload = b64url(Buffer.from(JSON.stringify(claim)))
  return { ...extra, 'X-Kortix-User-Context': `${payload}.${b64url(createHmac('sha256', secret).update(payload).digest())}` }
}
const get = (path: string, signal?: AbortSignal) => fetch(url + path, { headers: headers(), signal })

/** A POST to the wire, its JSON answer typed by the caller (the wire's documented shape), null for 204. */
async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(url + path, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`opencode ${path} ${res.status} ${await res.text()}`)
  return (res.status === 204 ? null : await res.json()) as T
}
/** A message as the wire answers it: its parts, and the assistant's info (cost, error). */
type WireMessage = { info?: Parameters<typeof chargeAgent>[0] & { role?: string; error?: unknown }; parts: { type: string; text?: string; synthetic?: boolean }[] }

let shared: Promise<string> | undefined
/** `new` starts a fresh session; no id reuses OPENCODE_SESSION, or one session per process. */
export function session(id?: string | null): Promise<string> {
  const once = () => post<{ id: string }>('/session', { title: 'voice' }).then((s) => s.id)
  const create = () => once().catch(() => Bun.sleep(1000).then(once)) // a box still starting answers a second later
  if (id === 'new') return create()
  if (id) return Promise.resolve(id)
  return (shared ??= process.env.OPENCODE_SESSION ? Promise.resolve(process.env.OPENCODE_SESSION) : create())
}

const text = (parts: { type: string; text?: string; synthetic?: boolean }[]) =>
  parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim()

/** Runs one agent turn and returns its final text. */
export async function ask(sid: string, request: string): Promise<string> {
  const r = await post<WireMessage>(`/session/${sid}/message`, { ...(model && { model }), parts: [{ type: 'text', text: request }] })
  if (r.info?.role === 'assistant') chargeAgent(r.info)
  return text(r.parts) || (r.info?.error ? `The agent failed: ${JSON.stringify(r.info.error).slice(0, 200)}` : 'Done.')
}

/** Appends text to the session without starting a turn: the call transcript becomes session memory. */
export async function remember(sid: string, note: string, synthetic = false) {
  await post(`/session/${sid}/prompt_async`, { noReply: true, parts: [{ type: 'text', text: note, ...(synthetic && { synthetic: true }) }] })
}

/** Human-readable history plus factual voice state, read in the same native request. */
export async function recall(sid: string, chars = 1500): Promise<Recall> {
  const res = await get(`/session/${sid}/message`)
  if (!res.ok) return { text: '', thread: {} }
  const messages: unknown = await res.json()
  if (!Array.isArray(messages)) return { text: '', thread: {} }
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const history: string[] = [], users: string[] = []
  let snapshot: ThreadSnapshot | undefined
  for (const message of messages as unknown[]) {
    if (!object(message) || !object(message.info) || !Array.isArray(message.parts)) continue
    const parts = message.parts.filter((part: unknown): part is { type: string; text?: string; synthetic?: boolean } =>
      object(part) && typeof part.type === 'string' && (part.text === undefined || typeof part.text === 'string') && (part.synthetic === undefined || typeof part.synthetic === 'boolean'))
    const spoken = text(parts)
    if (spoken) history.push(`${String(message.info.role)}: ${spoken}`)
    if (message.info.role !== 'user') continue
    for (const part of parts) {
      if (part.type === 'text' && part.synthetic && part.text) snapshot = threadNote(part.text) ?? snapshot
    }
    if (!spoken) continue
    if (spoken.startsWith('Voice call transcript, ended ')) {
      for (const match of spoken.matchAll(/^user: (.*)$/gm)) users.push(match[1]!.slice(0, 600))
      continue
    }
    if (spoken.startsWith('<data ') || spoken.startsWith('<task_notification>')) continue
    // Older pi voice messages joined the hidden context and actual caller words into one part.
    const user = spoken.startsWith("Reply in the language of the user's last words")
      ? spoken.slice(spoken.lastIndexOf('\n\n') + 2) : spoken
    users.push(user.replace(/^\[said while you work\]\s*/, '').slice(0, 600))
  }
  let size = 0, first = users.length
  while (first && size + users[first - 1]!.length <= 6000) size += users[--first]!.length
  return { text: history.join('\n').slice(-chars), thread: { snapshot, users: users.slice(first) } }
}

/** What the agent is doing right now: its latest tool call, e.g. `bash: bun test`. */
export async function progress(sid: string): Promise<string> {
  const res = await get(`/session/${sid}/message?limit=1`)
  if (!res.ok) return ''
  const [m] = (await res.json()) as { parts: { type: string; tool?: string; state?: { status: string; title?: string } }[] }[]
  const t = m?.parts.findLast((p) => p.type === 'tool')
  return t ? `${t.tool}: ${t.state?.title ?? t.state?.status}`.slice(0, 160) : ''
}

// A turn whose events stop (the stream reconnecting while the reply finished, or stalled) never ended: the call heard the
// bridge, then silence until the caller gave up (7 calls in ~40 drive runs of 36, 2026-11-01). After WATCH ms without an
// event the session's latest messages are read instead: the reply's text is taken from there, and a finished reply ends
// the turn.
const WATCH = Number(process.env.VOICE_TURN_WATCH_MS ?? 8000)

/** One event stream per call, reconnecting: every turn reads it, and so does the watch for turns the agent starts itself. */
// Older kortixd and OpenCode serve the stream at /event; kortixd's pi surface (Suna dev, 2026-10-31) only at
// /global/event, same frames. The first 404 switches every later connection.
let eventPath = '/event'
export function bus(sid: string): Bus {
  const fns = new Set<(type: string, e: any) => void>()
  const ac = new AbortController()
  ;(async () => {
    while (!ac.signal.aborted) {
      try {
        let res = await get(eventPath, ac.signal)
        if (res.status === 404 && eventPath === '/event') res = await get((eventPath = '/global/event'), ac.signal)
        const dec = new TextDecoder()
        let buf = ''
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop()!
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const { type, properties: e } = JSON.parse(line.slice(6))
            if ((e?.sessionID ?? e?.part?.sessionID ?? e?.info?.sessionID) === sid) for (const fn of fns) fn(type, e)
          }
        }
      } catch {}
      if (!ac.signal.aborted) await Bun.sleep(500)
    }
  })()
  return { on: (fn) => (fns.add(fn), () => void fns.delete(fn)), close: () => ac.abort() }
}

/**
 * Streams one agent turn until the session is idle again: a user turn when `text` is given, else the turn
 * already running (one the agent started itself, e.g. with a background task's report). Text comes from
 * `message.part.delta` (streaming providers) or `message.part.updated` snapshots (others); reasoning parts
 * are skipped. A prompt sent while the session is busy is queued and answered inside the same busy period.
 */
export function turn(events: Bus, sid: string, text: string | undefined, opts: { system?: string; context?: string; model?: string; signal?: AbortSignal; synthetic?: boolean }, on: TurnEvents): Promise<void> {
  const assistant = new Set<string>() // assistant message ids
  type Part = { type: string; sent: number; early: string; announced?: true }
  const parts = new Map<string, Part>()
  // The prompt carries our own message id, and the agent's reply to it names it as its parent: the turn begins
  // there (or at busy after the prompt landed), and only then does the session's idle count. A turn aborted a
  // moment before sends its last update and idle late; taken as ours, they ended the new turn before its answer
  // (two simulated calls lost an answer this way). Once begun, later replies in the same busy period are this
  // turn too: answers to words steered in, reports of background work.
  const id = text === undefined ? '' : mint()
  let started = text === undefined
  let since = 0 // server time the turn began
  let posted = false
  const ours = (e: any) => text === undefined || e.info.parentID === id || (started && (e.info.time?.created ?? 0) >= since)
  let open = '' // the text part being written; a new part or a finished message ends its line
  // Each reply's cost, once it is complete (the session reports it: cost in USD, tokens), charged to this call.
  const paid = new Set<string>()
  const pay = (info: any) => info?.time?.completed && !paid.has(info.id) && (paid.add(info.id), chargeAgent(info))
  const close = () => open && ((open = ''), on.text('\n'))
  const emit = (id: string, full?: string, delta?: string) => {
    const s = parts.get(id)!
    if (s.type !== 'text') return
    const add = delta ?? full!.slice(s.sent)
    if (!add) return
    if (open !== id) close()
    open = id
    s.sent += add.length
    on.text(add)
  }
  return new Promise((done) => {
    let heard = Date.now() // the last event of this session
    const off = events.on((type, e) => {
      heard = Date.now()
      if (type === 'session.status' && e.status?.type === 'busy' && posted && !started) (started = true), (since = Date.now() - 100)
      // pi's context compaction arrives as an assistant message flagged `summary` ("Goal: Build, optimize…"): it is the
      // model's notes, never speech (a background answer read one aloud, 2026-11-01).
      if (type === 'message.updated' && e.info.role === 'assistant' && !e.info.summary && ours(e)) {
        if (!started) (started = true), (since = e.info.time?.created ?? Date.now())
        assistant.add(e.info.id)
        if (e.info.time?.completed) close(), pay(e.info) // its last sentence can be spoken now, before the session settles
        if (e.info.error && e.info.error.name !== 'MessageAbortedError') on.error(e.info.error.data?.message ?? e.info.error.name)
      } else if (type === 'message.part.updated' && assistant.has(e.part.messageID)) {
        const s: Part = parts.get(e.part.id) ?? { type: e.part.type, sent: 0, early: '' }
        parts.set(e.part.id, s)
        s.type = e.part.type
        if (s.early) emit(e.part.id, undefined, s.early), (s.early = '')
        if (e.part.type === 'text') emit(e.part.id, e.part.text)
        if (e.part.type === 'tool' && e.part.state?.status === 'running' && !s.announced) {
          s.announced = true
          on.tool(e.part.tool, e.part.state.title ?? '')
        }
      } else if (type === 'message.part.delta' && e.field === 'text') {
        const s = parts.get(e.partID)
        if (s && s.type !== '?') emit(e.partID, undefined, e.delta)
        else if (s) s.early += e.delta
        else parts.set(e.partID, { type: '?', sent: 0, early: e.delta }) // its type arrives with the next update
      } else if (started && ((type === 'session.status' && e.status?.type === 'idle') || type === 'session.idle')) end()
    })
    // Only for a turn we asked for: a turn the agent started itself has no reply to look for.
    const watch = text === undefined ? undefined : setInterval(async () => {
      if (!posted || Date.now() - heard < WATCH) return
      heard = Date.now() // one read per quiet stretch
      const res = await get(`/session/${sid}/message?limit=6`).catch(() => undefined)
      const list = (res?.ok ? await res.json().catch(() => []) : []) as any[]
      if (!Array.isArray(list)) return
      const mine = list.filter((m) => m?.info?.role === 'assistant' && !m.info.summary && (m.info.parentID === id || (started && (m.info.time?.created ?? 0) >= since)))
      for (const m of mine) {
        assistant.add(m.info.id)
        pay(m.info)
        if (!started) (started = true), (since = m.info.time?.created ?? Date.now())
        for (const part of m.parts ?? []) {
          if (part?.type !== 'text' || typeof part.text !== 'string' || part.synthetic) continue
          const s: Part = parts.get(part.id) ?? { type: 'text', sent: 0, early: '' }
          parts.set(part.id, s)
          s.type = 'text'
          emit(part.id, part.text)
        }
      }
      const last = mine.at(-1)
      if (last?.info.time?.completed) close(), end() // newer user entries may be notes (remember), not prompts
    }, 1000)
    const end = () => (clearInterval(watch), off(), done())
    opts.signal?.addEventListener('abort', end)
    if (text === undefined) return
    const [p, ...m] = (opts.model ?? '').split('/')
    send(sid, text, { messageID: id, system: opts.system, ...(p && m.length && { model: { providerID: p, modelID: m.join('/') } }) }, opts.synthetic, opts.context)
      .then(() => (posted = true))
      .catch((err) => (on.error(String(err)), end()))
  })
}

// Kortix message ids: `msg_` + the low 48 bits of Date.now() * 0x1000 as 12 hex digits + 14 random base62
// characters (@kortix/sdk wire-message-id.ts).
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const mint = () =>
  `msg_${((BigInt(Date.now()) * 0x1000n) & 0xffffffffffffn).toString(16).padStart(12, '0')}${Array.from({ length: 14 }, () => B62[(Math.random() * 62) | 0]).join('')}`

/**
 * Puts the user's words into the running turn, which reads them at its next step boundary, so a question
 * asked while the agent works is answered in that turn instead of after it. kortixd's steer needs the box's
 * service credential (inside the box; through apps/api it is `delivery: steer`). False when no turn runs.
 */
export async function steer(sid: string, text: string): Promise<boolean> {
  const res = await fetch(`${url}/kortix/runtime/sessions/${sid}/steer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KORTIX_TOKEN}`, 'X-Kortix-Service-Call': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }], message_id: mint() }),
  }).catch(() => undefined)
  return res?.status === 202 || res?.status === 200
}

/**
 * Queues a user turn (answered after the current step if the agent is busy). `synthetic`: harness context the model
 * reads and the transcript hides. `context`: per-turn harness context in a hidden part of the same message. It
 * belongs there, not in the per-turn `system` text: kortixd appends that to the system prompt, ahead of the history,
 * so a system text that changes every turn spoils the provider's prompt cache for the whole call (first text
 * 1036 → 940 ms median with it moved, 8 turns each; more as the history grows, RESEARCH.md §3.17).
 */
export const send = (sid: string, text: string, extra: object = {}, synthetic = false, context?: string) =>
  post(`/session/${sid}/prompt_async`, {
    ...extra,
    // The hidden part ends in a blank line: pi joins parts without a separator ("…in English).Name a fruit").
    parts: [...(context ? [{ type: 'text', text: `${context.trim()}\n\n`, synthetic: true }] : []), { type: 'text', text, ...(synthetic && { synthetic: true }) }],
  })

/** Stops the agent's current turn. */
export const abort = (sid: string) => post(`/session/${sid}/abort`, {}).catch(() => null)
