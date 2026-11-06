// The agent seam: what the voice needs from the agent behind it. The voice (src/cascade.ts, src/server.ts) reaches it
// only through src/brain.ts, whose backend is src/agents/pi.ts (a pi / omp AgentSession in this process, or the
// session of the pi host the relay runs inside). A backend is a plain object of these functions; nothing above this line knows which one runs.
import type { ThreadSeed } from './thread'

/** What one agent turn says while it runs: its text as it streams, each tool it starts, and an error it reports. */
export type TurnEvents = { text(delta: string): void; tool(name: string, title: string): void; error(message: string): void }

/**
 * One event stream per call. Every turn reads it, and so does the call's watch for turns the agent starts itself.
 * The one frame every backend sends and the voice relies on: `('session.status', { status: { type: 'busy' | 'idle' } })`
 * when the session starts or stops working. Other frames are the backend's own (pi's `message_update`,
 * `tool_execution_start`, …) and only its own `turn` reads them.
 */
export type Bus = { on(fn: (type: string, e: any) => void): () => void; close(): void }

/** Human-readable recent history, and the voice's routing state saved in the session (src/thread.ts). */
export type Recall = { text: string; thread: ThreadSeed }

export type TurnOptions = {
  /** Per-turn system text (the voice's rules for this turn). */
  system?: string
  /** Per-turn harness context the model reads and the transcript hides. */
  context?: string
  /** A model for this turn (`provider/model`), where the backend can switch per turn. */
  model?: string
  /** Ends the turn for the caller (the agent is stopped with `abort`, not by this). */
  signal?: AbortSignal
  /** The text is harness-made (a nudge, a deeper look): the model reads it, the transcript hides it. */
  synthetic?: boolean
}

export type SendExtra = { system?: string; messageID?: string; model?: { providerID: string; modelID: string } }

export interface Agent {
  /** `new` starts a fresh session; an id reuses that one; none: one shared session per process. */
  session(id?: string | null): Promise<string>
  /** Runs one agent turn and returns its final text. */
  ask(sid: string, request: string): Promise<string>
  /** Adds text to the session without starting a turn (`synthetic`: harness state, hidden from the transcript). */
  remember(sid: string, note: string, synthetic?: boolean): Promise<void>
  /** Recent history and the voice's saved routing state. */
  recall(sid: string, chars?: number): Promise<Recall>
  /** What the agent is doing right now: its latest tool call, e.g. `bash: bun test`. */
  progress(sid: string): Promise<string>
  /** The call's event stream. */
  bus(sid: string): Bus
  /**
   * Streams one agent turn until the session is idle again: a user turn when `text` is given, else the turn already
   * running (one the agent started itself). A prompt sent while the session is busy is queued and answered inside
   * the same busy period.
   */
  turn(events: Bus, sid: string, text: string | undefined, opts: TurnOptions, on: TurnEvents): Promise<void>
  /** Puts words into the running turn, read at its next step. False when no turn runs. */
  steer(sid: string, text: string): Promise<boolean>
  /** Queues a user turn without following it (answered after the current step if the agent is busy). */
  send(sid: string, text: string, extra?: SendExtra, synthetic?: boolean, context?: string): Promise<unknown>
  /** Stops the agent's current turn. */
  abort(sid: string): Promise<unknown>
}
