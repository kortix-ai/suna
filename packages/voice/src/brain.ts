// The voice's agent, whichever backend runs it (src/agent.ts is the seam; src/cascade.ts and src/server.ts call only
// this module). VOICE_AGENT picks the backend:
// - `wire` (default): the OpenCode-shaped HTTP+SSE wire of kortixd or `opencode serve` (src/agents/wire.ts),
// - `pi`: pi or omp in this process, through its SDK's AgentSession (src/agents/pi.ts; the SDK is loaded only then).
// A pi host that runs the relay inside itself binds the session it runs in with `use()` (pi/extension.ts).
import type { Agent, SendExtra, TurnEvents, TurnOptions } from './agent'
import * as pi from './agents/pi'
import * as wire from './agents/wire'
export type { Agent, Bus, Recall, SendExtra, TurnEvents, TurnOptions } from './agent'

let standalone: Agent | undefined
let bound: Agent | undefined
// A host with several sessions in one process (a Kortix box: one relay, a call per session) binds each by the id a
// call names it with (`/stream?session=<id>`); a call's every agent call carries that id, so it reaches its own.
const sessions = new Map<string, Agent>()
const backends: Record<string, () => Agent> = { wire: () => wire, pi: () => (standalone ??= pi.standalone()) }

/** The agent every call uses: the one bound with `use`, else VOICE_AGENT's. */
export function agent(): Agent {
  if (bound) return bound
  const kind = process.env.VOICE_AGENT || 'wire'
  const pick = backends[kind]
  if (!pick) throw new Error(`VOICE_AGENT=${kind}: expected one of ${Object.keys(backends).join(', ')}`)
  return pick()
}

/** Binds the voice to this agent from now on (a pi host binds its own session); undefined goes back to VOICE_AGENT. */
export function use(next: Agent | undefined) {
  bound = next
}

/** Binds one session of a many-session host under `id`; undefined unbinds it (the session shut down). */
export function bind(id: string, next: Agent | undefined) {
  if (next) sessions.set(id, next)
  else sessions.delete(id)
}

const of = (sid: string | null | undefined) => (sid && sessions.get(sid)) || agent()
/** A bound session's own id stands; any other goes to the agent, which makes or finds one. */
export const session = (id?: string | null) => (id && sessions.has(id) ? Promise.resolve(id) : agent().session(id))
export const ask = (sid: string, request: string) => of(sid).ask(sid, request)
export const remember = (sid: string, note: string, synthetic = false) => of(sid).remember(sid, note, synthetic)
export const recall = (sid: string, chars?: number) => of(sid).recall(sid, chars)
export const progress = (sid: string) => of(sid).progress(sid)
export const bus = (sid: string) => of(sid).bus(sid)
export const turn = (events: ReturnType<Agent['bus']>, sid: string, text: string | undefined, opts: TurnOptions, on: TurnEvents) => of(sid).turn(events, sid, text, opts, on)
export const steer = (sid: string, text: string) => of(sid).steer(sid, text)
export const send = (sid: string, text: string, extra?: SendExtra, synthetic?: boolean, context?: string) => of(sid).send(sid, text, extra, synthetic, context)
export const abort = (sid: string) => of(sid).abort(sid)
