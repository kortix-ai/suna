/**
 * The session turn verbs `routes/kortix/runtime.ts` serves: start a turn,
 * stop it, read or remove one message, and list the agents. Each harness
 * implements them its own way (OpenCode through its REST API, pi in-process),
 * so the host speaks only Kortix names.
 */

/** A validated `POST /kortix/runtime/sessions/:id/prompt` body. */
export interface RuntimePromptInput {
  /** The client-minted message id, placed by the caller. */
  messageId?: string
  /** `text` and `file` parts, in the transcript's part shape. */
  parts: Array<Record<string, unknown>>
  agent?: string
  /** `provider/model`, split at the first slash. */
  model?: { providerID: string; modelID: string }
  variant?: string
  directory?: string
  /** Persist the message and start no turn. */
  noReply?: boolean
}

/** The HTTP answer a verb produced; the route sends it as it is. */
export interface HarnessTurnResponse {
  status: number
  body: unknown
}

export interface HarnessTurnService {
  /** 202 `{ message_id }`, 200 `{ deduplicated: true }`, or an error status. */
  prompt(runtimeSessionId: string, input: RuntimePromptInput): Promise<HarnessTurnResponse>
  abort(runtimeSessionId: string): Promise<HarnessTurnResponse>
  /** 200 `{ info, parts }` or 404. */
  readMessage(runtimeSessionId: string, messageId: string): Promise<HarnessTurnResponse>
  /** 2xx on removal, 404 when already gone, 409 while the message runs. */
  removeMessage(runtimeSessionId: string, messageId: string): Promise<HarnessTurnResponse>
  /** 200 `{ agents: [{ name, description, mode }] }`. */
  agents(directory: string | null): Promise<HarnessTurnResponse>
}
