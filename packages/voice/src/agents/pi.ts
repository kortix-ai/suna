// pi as the voice's agent, in this process: no HTTP hop between the voice and the agent loop (VOICE_AGENT=pi, or a pi
// host that runs the relay inside itself). Works over either face of the same session:
// - an SDK AgentSession (`fromSession`; `standalone()` makes one with createAgentSession, the SDK imported only then),
// - an extension's own ExtensionAPI and ctx (`fromExtension`), so a relay started inside pi, omp or kortixd talks to
//   the session it runs in (pi/extension.ts).
// The mapping: a turn is a prompt (a hidden one is a custom message with display false that starts a turn), followed
// through message_update text deltas and tool_execution_start events until the agent settles; steer is pi's steer;
// a note is a hidden custom message that starts no turn; the per-turn system text goes in through before_agent_start
// and the per-turn context through pi's `context` event, which joins it to the voice's own prompt in each model call
// of that run and stores nothing: the session keeps the caller's words and the answer, never the call's state;
// abort is pi's abort; recall reads the session's messages.
// Both pi 1.x (@earendil-works) and omp (@oh-my-pi) are taken by shape, not by import: nothing here loads pi.
import { randomUUID } from 'node:crypto'
import type { Agent, Bus, Recall, SendExtra, TurnEvents, TurnOptions } from '../agent'
import { chargeAgent } from '../cost'
import { threadNote, type ThreadSnapshot } from '../thread'

/** A pi event: AgentSession.subscribe and ExtensionAPI.on carry the same shapes in both hosts. */
export type PiEvent = { type: string; [key: string]: any }
type Block = { type: string; text?: string; name?: string; arguments?: unknown }
/** A message in pi's session: user, assistant, toolResult, or custom (an extension's, `display` false hides it). */
export type PiMessage = {
  role: string
  content?: string | Block[]
  customType?: string
  details?: any
  timestamp?: number
  stopReason?: string
  errorMessage?: string
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
  provider?: string
  model?: string
}
type Custom = { customType: string; content: string; display: boolean; details?: unknown }
type Handler = (event: any, ctx?: any) => unknown

/** What the adapter uses of an extension's ExtensionAPI (pi 1.x and omp alike). */
export type ExtensionLike = {
  on(event: string, handler: Handler): unknown
  sendMessage(message: Custom, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): unknown
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): unknown
}
/** What the adapter uses of an extension's ctx. */
export type ContextLike = {
  isIdle(): boolean
  abort(): unknown
  sessionManager: { getSessionId(): string; getBranch(): readonly unknown[] }
}
/** What the adapter uses of an SDK AgentSession (createAgentSession's `session`). */
export type AgentSessionLike = {
  subscribe(listener: (event: PiEvent) => void): () => void
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; expandPromptTemplates?: boolean }): Promise<unknown>
  steer(text: string): Promise<unknown>
  sendCustomMessage(message: Custom, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): Promise<unknown>
  abort(): Promise<unknown>
  readonly isStreaming: boolean
  readonly isIdle?: boolean
  readonly messages: readonly unknown[]
  readonly sessionManager?: { getSessionId(): string }
  dispose?(): unknown
}

/** A pi session as the voice's agent. It serves one session: every `sid` it is given means that one. */
export type PiAgent = Agent & { id(): string; dispose(): void }

/** What the adapter needs from pi, the same over an SDK session and over an extension's API. */
type Port = {
  id(): string
  /** Registered once per adapter. */
  subscribe(fn: (e: PiEvent) => void): void
  /** before_agent_start, registered once; false when this face has none (then system is dropped, context inlined). */
  hook(fn: Handler): boolean
  /** pi's `context` event (the messages of one model call, changed for that call only), registered once; false when
   * this face has none (then context is a hidden message beside the words, stored in the session). */
  transform(fn: Handler): boolean
  prompt(text: string, hidden: { id: string } | undefined, busy: boolean): Promise<unknown>
  steer(text: string): Promise<unknown>
  note(text: string, details: object): Promise<unknown>
  abort(): Promise<unknown>
  idle(): boolean
  messages(): PiMessage[]
  dispose(): void
}

/** The custom type of the voice's messages in pi's session (notes, hidden turns); `voice-context` is per-turn context
 * on a host without pi's `context` event. */
export const VOICE = 'voice'
const CONTEXT = 'voice-context'
// The events a turn reads; an extension subscribes to each by name.
const EVENTS = ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end', 'tool_execution_start']
// After a final agent_end, how long the session may take to report idle (hosts without agent_settled, e.g. omp).
const SETTLE_MS = Number(process.env.VOICE_PI_SETTLE_MS ?? 2000)
// How long a run the voice started may take to begin (a compaction runs first) before the turn reports it never did:
// an extension's sendUserMessage returns nothing, so a refused prompt shows no other way.
const START_MS = Number(process.env.VOICE_PI_START_MS ?? 60_000)

const textOf = (content: PiMessage['content']) =>
  typeof content === 'string' ? content.trim() : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim() : ''
/** A tool call's title for the voice: its first string argument's first line (a command, a path, a query). */
const title = (args: unknown) => {
  const v = args && typeof args === 'object' ? Object.values(args).find((x) => typeof x === 'string' && x.trim()) : undefined
  return typeof v === 'string' ? v.trim().split('\n')[0]!.slice(0, 160) : ''
}
/** An agent_end the host says is not the end: a retry, a continuation, an async resume (pi 1.x, omp). */
const continues = (e: PiEvent) => e.willRetry === true || e.willContinue === true || e.isTerminal === false
const charge = (m: PiMessage) => {
  const u = m.usage
  if (!u) return
  // pi's `reasoning` is a part of `output` already: not added again.
  chargeAgent({ cost: u.cost?.total, providerID: m.provider, modelID: m.model, tokens: { input: u.input, output: u.output, cache: { read: u.cacheRead, write: u.cacheWrite } } })
}

/** The adapter over a port. */
function adapter(port: Port): PiAgent {
  const listeners = new Set<(e: PiEvent) => void>()
  // The voice's prompts in the session's runs, each with its context: pi's `context` event joins each to its prompt in
  // every model call that carries it, and nothing of it is stored. One is dropped at the end of a run that carried it,
  // or of the second run that did not (its words never reached the model).
  const joins = new Map<string, { text: string; context: string; seen?: true; runs: number }>()
  let answered = false
  let joined = false
  port.subscribe((e) => {
    if (e.type === 'message_start' && e.message?.role === 'assistant') answered = true
    if (e.type === 'agent_settled' || (e.type === 'agent_end' && !continues(e))) {
      // A host whose model answered with the voice's prompts in its run but never fired `context` would lose every
      // turn's context: from then on it gets the hidden message (or the inline text, queued).
      if (transformed && answered && !joined && joins.size) {
        transformed = false
        console.error('[voice] pi fired no context event for a run: per-turn context goes in as a hidden message')
      }
      for (const [id, j] of joins) if (j.seen || ++j.runs > 1) joins.delete(id)
      answered = joined = false
    }
    for (const fn of [...listeners]) fn(e)
  })
  let transformed = port.transform((e) => {
    const messages = e?.messages as PiMessage[] | undefined
    if (!joins.size || !Array.isArray(messages)) return
    joined = true
    // Each prompt of the voice is its latest match: its hidden turn's message, or a user message that holds its words
    // (an earlier one with the same words is an earlier turn).
    const at = new Map<number, string>()
    for (const [id, j] of joins) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (!(m?.details?.voiceTurn === id || (m?.role === 'user' && textOf(m.content).includes(j.text)))) continue
        if (!at.has(i)) at.set(i, j.context), (j.seen = true)
        break
      }
    }
    if (!at.size) return
    return {
      messages: messages.map((m, i) => {
        const context = at.get(i)
        if (context === undefined) return m
        return { ...m, content: typeof m.content === 'string' ? `${context}\n\n${m.content}` : [{ type: 'text', text: context }, ...(m.content ?? [])] }
      }),
    }
  })
  // The run the voice is about to start: its system text (and, on a host without `context`, its hidden context),
  // applied by before_agent_start only to that run (a run someone else starts in the same session, e.g. typed in pi's
  // own UI, keeps its own prompt).
  let pending: { id: string; text: string; system?: string; context?: string } | undefined
  const hooked = port.hook((e) => {
    const p = pending
    if (!p || !(e?.message?.details?.voiceTurn === p.id || (typeof e?.prompt === 'string' && e.prompt.includes(p.text)))) return
    pending = undefined
    const out: { systemPrompt?: string | string[]; message?: Custom } = {}
    if (p.system) out.systemPrompt = Array.isArray(e.systemPrompt) ? [...e.systemPrompt, p.system] : [e.systemPrompt, p.system].filter(Boolean).join('\n\n')
    if (p.context && !transformed) out.message = { customType: CONTEXT, content: p.context, display: false, details: { voiceTurn: p.id } }
    return out
  })

  /** Starts a run (`now`: the session is idle, the next run is this one) or queues the words behind the running one. */
  const start = (id: string, text: string, o: { system?: string; context?: string; synthetic?: boolean }, now: boolean) => {
    const context = o.context?.trim() || undefined
    if (context && transformed) joins.set(id, { text, context, runs: 0 })
    // Without `context`, a queued message joins a run whose system prompt is set: its context rides in its own text.
    const inline = context && !transformed && (!now || !hooked)
    if (now && hooked) pending = { id, text, system: o.system, context }
    return port.prompt(inline ? `${context}\n\n${text}` : text, o.synthetic ? { id } : undefined, !now)
  }

  const bus = (): Bus => {
    let idle = true
    const fns = new Set<(type: string, e: any) => void>()
    const emit = (type: string, e: unknown) => { for (const fn of [...fns]) fn(type, e) }
    const status = (busy: boolean) => busy !== !idle && ((idle = !busy), emit('session.status', { status: { type: busy ? 'busy' : 'idle' } }))
    const listener = (e: PiEvent) => {
      if (e.type === 'agent_start') status(true)
      emit(e.type, e)
      if (e.type === 'agent_settled' || (e.type === 'agent_end' && !continues(e))) status(false)
    }
    listeners.add(listener)
    return { on: (fn) => (fns.add(fn), () => void fns.delete(fn)), close: () => void listeners.delete(listener) }
  }

  // `opts.model` is not applied: the run uses the pi session's own model (pi's /model, settings, VOICE_PI_MODEL).
  const turn = (events: Bus, _sid: string, text: string | undefined, opts: TurnOptions, on: TurnEvents) =>
    new Promise<void>((done) => {
      const id = randomUUID()
      const now = text !== undefined && port.idle()
      // A turn already running is followed from now; an asked one from its run's start (idle now) or from its words
      // entering the running one (queued). Until a run it started begins, a settle seen is the previous run's.
      let started = text === undefined || now
      let waiting = now
      let ended = false
      let open = '' // the text block being written; a new block or a finished message ends its line
      const paid = new Set<string>()
      let settle: ReturnType<typeof setInterval> | undefined
      const stopSettle = () => settle && (clearInterval(settle), (settle = undefined))
      const guard = now ? setTimeout(() => waiting && (on.error('pi did not start the turn'), end()), START_MS) : undefined
      const close = () => open && ((open = ''), on.text('\n'))
      const end = () => {
        if (ended) return
        ended = true
        clearTimeout(guard), stopSettle(), off()
        opts.signal?.removeEventListener('abort', end)
        if (pending?.id === id) pending = undefined
        joins.delete(id)
        done()
      }
      // Our words entering the session: the user message (its text holds ours) or the hidden turn's custom message.
      const mine = (m: PiMessage | undefined) =>
        !!m && (m.details?.voiceTurn === id || (text !== undefined && (m.role === 'user' || m.role === 'developer') && textOf(m.content).includes(text)))
      const off = events.on((type, e) => {
        if (ended) return
        if (type === 'agent_start') return void ((waiting = false), stopSettle())
        if (type === 'message_start' && mine(e.message)) return void ((started = true), (waiting = false))
        if (waiting) return
        if (type === 'agent_settled') return end() // nothing more will run: an answered turn, or one dropped from the queue
        if (!started) return
        if (type === 'message_update' && e.message?.role === 'assistant') {
          const a = e.assistantMessageEvent
          if (a?.type !== 'text_delta' || !a.delta) return
          const key = `${e.message.timestamp ?? ''}:${a.contentIndex ?? 0}`
          if (open && open !== key) close()
          open = key
          on.text(a.delta)
        } else if (type === 'message_end' && e.message?.role === 'assistant') {
          close() // its last sentence can be spoken now, before the session settles
          const key = `${e.message.timestamp ?? ''}:${e.message.responseId ?? ''}`
          if (!paid.has(key)) paid.add(key), charge(e.message)
          if (e.message.stopReason === 'error' && e.message.errorMessage) on.error(String(e.message.errorMessage))
        } else if (type === 'tool_execution_start' && !e.parentToolCallId) on.tool(String(e.toolName), title(e.args))
        else if (type === 'agent_end' && !continues(e)) {
          // Hosts with agent_settled end there; others once the session reports idle (or after SETTLE_MS).
          stopSettle()
          const until = Date.now() + SETTLE_MS
          settle = setInterval(() => (port.idle() || Date.now() > until) && end(), 20)
        }
      })
      if (opts.signal?.aborted) return end()
      opts.signal?.addEventListener('abort', end)
      if (text === undefined) return
      start(id, text, opts, now).catch((err: unknown) => { if (!ended) on.error(err instanceof Error ? err.message : String(err)), end() })
    })

  const self: PiAgent = {
    id: () => port.id(),
    dispose: () => (listeners.clear(), port.dispose()),
    session: async () => port.id(),
    bus: () => bus(),
    turn,
    async ask(sid, request) {
      const events = bus()
      let out = '', failed = ''
      try {
        await turn(events, sid, request, {}, { text: (d) => void (out += d), tool() {}, error: (m) => void (failed ||= m) })
      } finally {
        events.close()
      }
      return out.trim() || (failed ? `The agent failed: ${failed.slice(0, 200)}` : 'Done.')
    },
    async remember(_sid, note, synthetic = false) {
      await port.note(note, synthetic ? { synthetic: true } : {})
    },
    async recall(_sid, chars = 1500): Promise<Recall> {
      const history: string[] = [], users: string[] = []
      let snapshot: ThreadSnapshot | undefined
      for (const m of port.messages()) {
        const body = textOf(m.content)
        if (m.role === 'custom') {
          if (m.customType !== VOICE || m.details?.voiceTurn) continue // per-turn context, hidden prompts, others' messages
          if (m.details?.synthetic) { snapshot = threadNote(body) ?? snapshot; continue }
        } else if (m.role !== 'user' && m.role !== 'assistant') continue
        if (!body) continue
        // The voice's notes (a call's transcript, a line it said itself) are the conversation, as the user's words are.
        history.push(`${m.role === 'assistant' ? 'assistant' : 'user'}: ${body}`)
        if (m.role === 'assistant') continue
        if (body.startsWith('Voice call transcript, ended ')) {
          for (const match of body.matchAll(/^user: (.*)$/gm)) users.push(match[1]!.slice(0, 600))
          continue
        }
        if (body.startsWith('<data ') || body.startsWith('<task_notification>')) continue
        users.push(body.replace(/^\[said while you work\]\s*/, '').slice(0, 600))
      }
      let size = 0, first = users.length
      while (first && size + users[first - 1]!.length <= 6000) size += users[--first]!.length
      return { text: history.join('\n').slice(-chars), thread: { snapshot, users: users.slice(first) } }
    },
    async progress() {
      const last = port.messages().findLast((m) => m.role === 'assistant')
      const call = Array.isArray(last?.content) ? last.content.findLast((b) => b?.type === 'toolCall') : undefined
      return call ? `${call.name}: ${title(call.arguments)}`.slice(0, 160) : ''
    },
    async steer(_sid, text) {
      if (port.idle()) return false
      return port.steer(text).then(() => true, () => false)
    },
    // Handed to pi, not followed: the run it starts (or joins) is read by the call's watch like any other.
    async send(_sid, text, extra: SendExtra = {}, synthetic = false, context?: string) {
      start(randomUUID(), text, { system: extra.system, context, synthetic }, port.idle()).catch((err: unknown) => console.error('[voice] pi send failed', String(err)))
    },
    abort: () => port.abort(),
  }
  return self
}

/** The adapter over an SDK AgentSession. `ext`: the ExtensionAPI of an extension loaded into that session (its
 * before_agent_start carries the per-turn system text and hidden context); without it, context goes inline. */
export function fromSession(session: AgentSessionLike, ext?: Pick<ExtensionLike, 'on'>): PiAgent {
  const offs: (() => void)[] = []
  let live = true
  const fallback = randomUUID()
  return adapter({
    id: () => session.sessionManager?.getSessionId() ?? fallback,
    subscribe: (fn) => void offs.push(session.subscribe((e) => live && fn(e))),
    hook(fn) {
      if (!ext) return false
      const off = ext.on('before_agent_start', (e) => (live ? fn(e) : undefined))
      if (typeof off === 'function') offs.push(off as () => void)
      return true
    },
    transform(fn) {
      if (!ext) return false
      const off = ext.on('context', (e) => (live ? fn(e) : undefined))
      if (typeof off === 'function') offs.push(off as () => void)
      return true
    },
    prompt: (text, hidden, busy) =>
      hidden
        ? session.sendCustomMessage({ customType: VOICE, content: text, display: false, details: { voiceTurn: hidden.id } }, { triggerTurn: true, ...(busy && { deliverAs: 'followUp' as const }) })
        : session.prompt(text, { expandPromptTemplates: false, ...(busy && { streamingBehavior: 'followUp' as const }) }),
    steer: (text) => session.steer(text),
    note: (text, details) => session.sendCustomMessage({ customType: VOICE, content: text, display: false, details }, { triggerTurn: false }),
    abort: () => session.abort(),
    idle: () => (typeof session.isIdle === 'boolean' ? session.isIdle : !session.isStreaming),
    messages: () => session.messages as PiMessage[],
    dispose: () => ((live = false), offs.splice(0).forEach((off) => off())),
  })
}

/** pi keeps a session's history as entries: messages, and extensions' custom messages. */
function entryMessage(entry: unknown): PiMessage[] {
  const e = entry as { type?: string; message?: PiMessage; customType?: string; content?: PiMessage['content']; details?: unknown }
  if (e?.type === 'message' && e.message) return [e.message]
  if (e?.type === 'custom_message') return [{ role: 'custom', customType: e.customType, content: e.content, details: e.details }]
  return []
}

/**
 * The adapter from inside a pi host: the extension's own ExtensionAPI, and its ctx (or a function that returns the
 * latest one: pi replaces ctx on session replacement). The voice then talks to the session that extension runs in.
 */
export function fromExtension(pi: ExtensionLike, ctx: ContextLike | (() => ContextLike | undefined)): PiAgent {
  const offs: (() => void)[] = []
  let live = true
  let seen: ContextLike | undefined // the ctx the host passed with its latest event
  const current = () => {
    const c = (typeof ctx === 'function' ? ctx() : ctx) ?? seen
    if (!c) throw new Error('pi voice adapter: no extension context yet')
    return c
  }
  const on = (event: string, fn: Handler) => {
    const off = pi.on(event, (e, c) => {
      if (!live) return
      if (c && typeof c.isIdle === 'function') seen = c
      return fn(e, c)
    })
    if (typeof off === 'function') offs.push(off as () => void)
  }
  return adapter({
    id: () => current().sessionManager.getSessionId(),
    subscribe: (fn) => { for (const event of EVENTS) on(event, (e) => fn({ ...e, type: e?.type ?? event })) },
    hook: (fn) => (on('before_agent_start', fn), true),
    transform: (fn) => (on('context', fn), true),
    prompt: async (text, hidden, busy) =>
      hidden
        ? pi.sendMessage({ customType: VOICE, content: text, display: false, details: { voiceTurn: hidden.id } }, { triggerTurn: true, ...(busy && { deliverAs: 'followUp' as const }) })
        : pi.sendUserMessage(text, busy ? { deliverAs: 'followUp' } : undefined),
    steer: async (text) => pi.sendUserMessage(text, { deliverAs: 'steer' }),
    note: async (text, details) => pi.sendMessage({ customType: VOICE, content: text, display: false, details }, { triggerTurn: false }),
    async abort() {
      const c = current()
      c.abort()
      for (let i = 0; i < 200 && !c.isIdle(); i++) await new Promise((r) => setTimeout(r, 25))
    },
    idle: () => current().isIdle(),
    messages: () => current().sessionManager.getBranch().flatMap(entryMessage),
    dispose: () => ((live = false), offs.splice(0).forEach((off) => off())),
  })
}

/** The pi SDK's part the standalone relay uses (pi 1.x and omp export it from the package root). */
export type PiSdk = {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: AgentSessionLike }>
  DefaultResourceLoader?: new (options: Record<string, unknown>) => { reload(): Promise<void> }
  getAgentDir?: () => string
  SessionManager?: { inMemory(cwd?: string): unknown }
}

/**
 * The pi SDK, imported only when VOICE_AGENT=pi: VOICE_PI_SDK (a package name or a path) first, then omp and pi 1.x
 * as the relay resolves them, then as Bun installed them globally (`bun add -g`).
 */
export async function loadSdk(): Promise<PiSdk> {
  const names = ['@oh-my-pi/pi-coding-agent', '@earendil-works/pi-coding-agent']
  const global = `${process.env.BUN_INSTALL ?? `${process.env.HOME}/.bun`}/install/global/node_modules`
  const tries = [...(process.env.VOICE_PI_SDK ? [process.env.VOICE_PI_SDK] : []), ...names, ...names.map((n) => `${global}/${n}`)]
  const failed: string[] = []
  for (const spec of tries) {
    try {
      const sdk = (await import(spec)) as PiSdk
      if (typeof sdk.createAgentSession === 'function') return sdk
    } catch (err) {
      failed.push(`${spec}: ${String(err).split('\n')[0]}`)
    }
  }
  throw new Error(`VOICE_AGENT=pi: no pi SDK found (set VOICE_PI_SDK). Tried:\n${failed.join('\n')}`)
}

/**
 * A new pi session in this process, the voice's hooks loaded into it as an inline extension. pi 1.x takes inline
 * extensions through its resource loader, omp directly; pi's own discovery (extensions, skills, AGENTS.md, settings,
 * the default model and its keys) applies as in the pi CLI started in VOICE_PI_CWD; VOICE_PI_MODEL picks omp's model,
 * VOICE_PI_MEMORY=1 keeps the session in memory only. An embedder adds its own createAgentSession options and inline
 * extensions with `extra`.
 */
export async function open(sdk: PiSdk, cwd = process.env.VOICE_PI_CWD ?? process.cwd(), extra: { options?: Record<string, unknown>; extensions?: ((pi: any) => unknown)[] } = {}): Promise<PiAgent> {
  let ext: ExtensionLike | undefined
  const factories = [(pi: ExtensionLike) => void (ext = pi), ...(extra.extensions ?? [])]
  const options: Record<string, unknown> = { cwd, ...(process.env.VOICE_PI_MODEL && { modelPattern: process.env.VOICE_PI_MODEL }), ...extra.options }
  if (process.env.VOICE_PI_MEMORY === '1' && sdk.SessionManager && !options.sessionManager) options.sessionManager = sdk.SessionManager.inMemory(cwd)
  if (sdk.DefaultResourceLoader && sdk.getAgentDir) {
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir: sdk.getAgentDir(), extensionFactories: factories })
    await resourceLoader.reload()
    options.resourceLoader = resourceLoader
  } else options.extensions = factories
  const { session } = await sdk.createAgentSession(options)
  const bind = (session as { bindExtensions?: (b: object) => Promise<void> }).bindExtensions
  if (typeof bind === 'function') await bind.call(session, {}) // pi 1.x: session_start for the loaded extensions
  return fromSession(session, ext)
}

/**
 * VOICE_AGENT=pi in a plain relay: pi sessions in this process, made on demand. No id: one shared per process; `new`:
 * a fresh one; an id it has not seen: a fresh one known by that id from then on.
 */
export function standalone(make: () => Promise<PiAgent> = async () => open(await loadSdk())): Agent {
  const agents = new Map<string, PiAgent>()
  let shared: Promise<string> | undefined
  const create = async (as?: string) => {
    const a = await make()
    agents.set(a.id(), a)
    if (as) agents.set(as, a)
    return as ?? a.id()
  }
  const of = (sid: string) => {
    const a = agents.get(sid)
    if (!a) throw new Error(`no pi session ${sid} in this relay`)
    return a
  }
  return {
    session(id) {
      if (id === 'new') return create()
      if (id) return agents.has(id) ? Promise.resolve(id) : create(id)
      return (shared ??= create())
    },
    ask: async (sid, request) => of(sid).ask(sid, request),
    remember: async (sid, note, synthetic) => of(sid).remember(sid, note, synthetic),
    recall: async (sid, chars) => of(sid).recall(sid, chars),
    progress: async (sid) => of(sid).progress(sid),
    bus: (sid) => of(sid).bus(sid),
    turn: async (events, sid, text, opts, on) => of(sid).turn(events, sid, text, opts, on),
    steer: async (sid, text) => of(sid).steer(sid, text),
    send: async (sid, text, extra, synthetic, context) => of(sid).send(sid, text, extra, synthetic, context),
    abort: async (sid) => of(sid).abort(sid),
  }
}
