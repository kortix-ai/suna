// The seam between a call and a speech-to-speech vendor. Audio is PCM16 mono little-endian.
import type { ThreadSeed } from './thread'

export type Tool = { name: string; description: string; parameters: object }

export type Opts = {
  model?: string
  voice?: string
  vad?: number // end-of-speech silence, ms
  wake?: string // a room with other people: only turns that name the agent count, plus follow-ups within 10 s
  room?: boolean // one participant among several (src/room.ts): listens, speaks when addressed or clearly wanted
  meeting?: string // the meeting the call is in (a bridge's Meet code): a restarted relay resumes its transcripts
  me?: string // in a meeting, the name of the person at the microphone: their words become "[me] ..." lines
  name?: string // the assistant's name in this call (else VOICE_NAME); look and style: its picture and how it behaves
  look?: string
  style?: string
  stt?: string // the recognizer for this call (src/speech.ts stts): whisper, whisper-turbo, gemini, scribe
  tts?: string // the voice for this call (src/speech.ts ttss): inworld, inworld-flash, xai-ws, gemini, eleven
  llm?: string // the agent's model for this call (kortix/<provider>/<model>), else VOICE_AGENT_MODEL
  lang?: string // the language the call starts in (the browser's); speech-to-text follows the user from there
  think?: string // reasoning level, where the vendor has one
  manual?: boolean // the client marks turns with turn(); vendor VAD is off
  session?: string // the agent session, for providers that talk to it directly
  agentTools?: boolean // that session's agent has the voice's tools (its host gave them): it acts with them, not tags
  trusted?: string[] // in a meeting, the speakers whose words may reach the agent (unset: everyone's); the rest are its guests
  instructions: string
  thread?: ThreadSeed // factual routing memory from the same native session
  tools: Tool[]
}

export type Hooks = {
  ready(): void
  audio(pcm: Uint8Array): void // model speech at outRate
  clear(): void // user barged in: drop queued playback
  duck?(on: boolean): void // user started talking over the agent: lower its volume until we know more
  hold?(on: boolean): void // overlap not settled yet: pause playback, keeping the queue (off: resume)
  listen?(): void // the agent made a listening sound ("mhm") while the user is still talking
  activity?(tool: string, title: string): void // the agent started a tool (agent-native providers)
  snap?(): void // the client should send fresh frames of what it shares now (a look is coming)
  spent?(): number // what the call has cost so far, USD (src/cost.ts)
  timing?(t: Record<string, number>): void // per-turn stage timeline, ms after the user stopped speaking
  event?(kind: string, data: Record<string, unknown>): void // a decision the voice layer made (traced per call, ignored by the client)
  text(role: 'user' | 'agent' | 'screen', text: string): void // one finished turn, or what a shared screen shows
  tool(id: string, name: string, args: Record<string, unknown>): void // answer later with result()
  close(why: string): void
}

export type Model = {
  inRate: number
  outRate: number
  literal?: boolean // say() speaks its text verbatim (no model in the voice layer)
  audio(pcm: Uint8Array): void
  input(text: string): void // a typed user turn: same conversation, same agent, spoken reply
  result(id: string, name: string, output: string): void // spoken once the user is not talking
  say(text: string, transient?: boolean): void // injection: speak once idle; transient = drop if newer news queues
  note(text: string): void // injection: silent context
  turn(state: 'start' | 'end'): void // manual turns: the user started / finished speaking
  image?(jpeg: Uint8Array | undefined, from?: string): void // a frame of a shared screen or a camera (undefined: it stopped)
  persona?(p: { name?: string; voice?: string; look?: string; style?: string; mode?: 'normal' | 'listen' | 'named' }): void // who it is from now on (src/persona.ts)
  see?(question: string): Promise<{ text: string; from: string[] }> // what the call shares, looked at for a question now
  control?(action: Record<string, unknown>): Promise<unknown> // one action on the call from outside (src/meta.ts: set, say, later, watch, cancel, capture, look)
  state?(): Record<string, unknown> // what the call is right now (src/meta.ts)
  peek?(text: string): void // words still being said, as a captions bridge sees them grow ("[Ana] ..."): a warm-up, never a turn
  close(): void | Promise<void>
}

export type Provider = (opts: Opts, hooks: Hooks) => Model

export const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64')
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
