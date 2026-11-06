/**
 * Every model request names the transcript message it belongs to, so the gateway's request log
 * links to it (apps/api `gateway_request_logs.metadata`, the Models > Logs "Open in session").
 *
 * - `x-kortix-message-id`: the assistant message this request produces. Only an agent-loop step
 *   produces one; a compaction or summary request (no `convertToLlm` in its options) does not.
 * - `x-kortix-turn-id`: the user message the running turn answers.
 * - `x-kortix-thread-id`: the in-box subagent thread, on a subagent's requests only.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core'

export const MESSAGE_ID_HEADER = 'x-kortix-message-id'
export const TURN_ID_HEADER = 'x-kortix-turn-id'
export const THREAD_ID_HEADER = 'x-kortix-thread-id'

export interface MessageIdentity {
  /** The id of the assistant message the next agent-loop step starts (`PiTurnEvents.reserveMessageId`). */
  reserveMessageId: () => string
  turnId: () => string | null
  threadId?: string
}

export function withMessageIdentity(stream: StreamFn, identity: MessageIdentity): StreamFn {
  return (model, context, options) => {
    const step = typeof (options as { convertToLlm?: unknown } | undefined)?.convertToLlm === 'function'
    const turnId = identity.turnId()
    const headers = {
      ...options?.headers,
      ...(step ? { [MESSAGE_ID_HEADER]: identity.reserveMessageId() } : {}),
      ...(turnId ? { [TURN_ID_HEADER]: turnId } : {}),
      ...(identity.threadId ? { [THREAD_ID_HEADER]: identity.threadId } : {}),
    }
    return stream(model, context, { ...options, headers })
  }
}
