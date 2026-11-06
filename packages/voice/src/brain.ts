// The voice's agent, whichever backend runs it (src/agent.ts is the seam; src/cascade.ts and src/server.ts call only
// this module). The backend is pi or omp: in this process through its SDK's AgentSession (src/agents/pi.ts; the SDK
// is loaded only then), or the session of the pi host the relay runs inside.
// A pi host that runs the relay inside itself binds the session it runs in with `use()` (pi/extension.ts).
import type { Agent, SendExtra, TurnEvents, TurnOptions } from './agent'
import * as pi from './agents/pi'
export type { Agent, Bus, Recall, SendExtra, TurnEvents, TurnOptions } from './agent'

let standalone: Agent | undefined
let bound: Agent | undefined
// A host with several sessions in one process (a Kortix box: one relay, a call per session) binds each by the id a
// call names it with (`/stream?session=<id>`); a call's every agent call carries that id, so it reaches its own.
const sessions = new Map<string, Agent>()
// The sessions whose host gave the agent the voice's tools (src/voice-tools.ts): it acts on its call with them.
const withTools = new Set<string>()
const backends: Record<string, () => Agent> = { pi: () => (standalone ??= pi.standalone()) }

/** The agent every call uses: the one bound with `use`, else VOICE_AGENT's. */
export function agent(): Agent {
  if (bound) return bound
  const kind = process.env.VOICE_AGENT || 'pi'
  const pick = backends[kind]
  if (!pick) throw new Error(`VOICE_AGENT=${kind}: expected one of ${Object.keys(backends).join(', ')}`)
  return pick()
}

/** Binds the voice to this agent from now on (a pi host binds its own session); undefined goes back to VOICE_AGENT. */
export function use(next: Agent | undefined) {
  bound = next
}

/** Binds one session of a many-session host under `id`; undefined unbinds it (the session shut down). `tools`: the
 * host gave that session's agent the voice's tools. `name`: the agent's own, the call's name unless the call names one. */
export function bind(id: string, next: Agent | undefined, o: { tools?: boolean; name?: string } = {}) {
  if (next) sessions.set(id, next)
  else sessions.delete(id)
  if (next && o.tools) withTools.add(id)
  else withTools.delete(id)
  if (next && o.name) names.set(id, o.name)
  else names.delete(id)
}
const names = new Map<string, string>()
/** The name of the agent bound under `sid`, if its host gave one. */
export const nameOf = (sid: string | null | undefined): string | undefined => (sid ? names.get(sid) : undefined)

/** The session's agent has the voice's tools: its turns name them in place of the tag list. */
export const tools = (sid: string | null | undefined) => !!sid && withTools.has(sid)

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
