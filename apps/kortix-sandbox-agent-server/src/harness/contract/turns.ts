/**
 * The session turn verbs `routes/kortix/runtime.ts` serves: start a turn,
 * stop it, read or remove one message, and list the agents. The harness
 * implements them (pi in-process), so the host speaks only Kortix names.
 */

import type { WorkflowControlBody } from '@kortix/api-contract/multi-agent'
import type { RuntimeCommandBody, RuntimePermissionReplyBody } from '@kortix/api-contract/runtime-relay'

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
  /**
   * Text added to this turn's system prompt only (`project_channels`: the
   * thread's memory file list). The next turn without it runs without it.
   */
  system?: string
}

/** The HTTP answer a verb produced; the route sends it as it is. */
export interface HarnessTurnResponse {
  status: number
  body: unknown
}

export interface HarnessTurnService {
  /** 202 `{ message_id }`, 200 `{ deduplicated: true }`, or an error status. */
  prompt(runtimeSessionId: string, input: RuntimePromptInput): Promise<HarnessTurnResponse>
  /**
   * Hand a message to the running turn, which reads it at its next step
   * boundary. `input.messageId` is set. 202 `{ message_id, steered: true }`,
   * 200 `{ deduplicated: true }`, 409 `{ code: STEER_NO_ACTIVE_TURN_CODE }`
   * when no turn runs (nothing is stored), 501 `{ code: 'feature_not_supported' }`.
   */
  steer(runtimeSessionId: string, input: RuntimePromptInput): Promise<HarnessTurnResponse>
  abort(runtimeSessionId: string): Promise<HarnessTurnResponse>
  /** 200 `{ info, parts }` or 404. */
  readMessage(runtimeSessionId: string, messageId: string): Promise<HarnessTurnResponse>
  /** 2xx on removal, 404 when already gone, 409 while the message runs. */
  removeMessage(runtimeSessionId: string, messageId: string): Promise<HarnessTurnResponse>
  /**
   * Take back a user message no model call has read: an unread steered
   * message, a prompt queued behind the running work, a `no_reply` message no
   * turn has read. 200 `{ retracted: true }`, 404 when there is no such
   * message, 409 `{ code: MESSAGE_READ_CODE }` when a model call read it.
   */
  retractMessage(runtimeSessionId: string, messageId: string): Promise<HarnessTurnResponse>
  /** 200 `{ agents: [{ name, description, mode }] }`. */
  agents(directory: string | null): Promise<HarnessTurnResponse>

  // The session-log actions (`RUNTIME_ACTIONS_CAPABILITY`, `@kortix/api-contract/runtime-relay`).

  /** 200 `{ ok: true }`; 404 when no such request waits. */
  replyPermission(requestId: string, body: RuntimePermissionReplyBody): Promise<HarnessTurnResponse>
  /** 200 `{ ok: true }`; 404 when no such question waits. */
  replyQuestion(requestId: string, answers: string[][]): Promise<HarnessTurnResponse>
  /** 200 `{ ok: true }`; 404 when no such question waits. */
  rejectQuestion(requestId: string): Promise<HarnessTurnResponse>
  /** 202 `{ ok: true }`: the summary runs as a turn of its own. */
  compact(runtimeSessionId: string): Promise<HarnessTurnResponse>
  /** 202 `{ message_id }`; 400 unknown command; 403 `{ error: 'command_not_enabled', command, agent }`. */
  command(runtimeSessionId: string, body: RuntimeCommandBody): Promise<HarnessTurnResponse>
  /** 200 `{ grants }`: the session's grants after the change. */
  setGrants(runtimeSessionId: string, grants: string[]): Promise<HarnessTurnResponse>
  /** 200 `{ commands: RuntimeCommandInfo[] }`. */
  commands(): Promise<HarnessTurnResponse>
  /** 200 `RuntimePending`: each thread's status and the requests that wait on a person. */
  pending(): Promise<HarnessTurnResponse>
  /**
   * 200 `{ thread_id, messages, has_more }`: one page of a thread of the box's own
   * session log, oldest first. `threadId` null: the root. `afterSeq` reads forward
   * from a seq; otherwise the page is the newest one before `beforeSeq`.
   */
  readLog(query: { threadId: string | null; afterSeq: number | null; beforeSeq: number | null; limit: number }): Promise<HarnessTurnResponse>
  /** 200 the `SessionLogMessage`; 404 when no thread holds it. */
  readLogMessage(messageId: string): Promise<HarnessTurnResponse>
  /** The bytes of an attachment the session log names by `sha256`, or null. */
  readBlob(sha256: string): Promise<{ bytes: Uint8Array; mime: string } | null>

  // Workflow runs (`@kortix/api-contract/multi-agent`, the workflow tool).

  /** 200 `{ runs: WorkflowRunMetadata[] }`: this session's runs, newest first. */
  workflows(): Promise<HarnessTurnResponse>
  /**
   * 200 `{ ok: true, paused }`; 404 unknown run; 409 `{ code: 'run_in_runner',
   * runner_session_id }` for a background run (its runner's box controls it),
   * `{ code: 'run_ended' }`, or `{ code: 'agent_not_running' }`.
   */
  controlWorkflow(runId: string, body: WorkflowControlBody): Promise<HarnessTurnResponse>
}
