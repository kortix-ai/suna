/**
 * The Kortix turn verbs on pi, answered in-process by the runtime: admit a
 * prompt, abort the run, read the transcript and the compiled agent set.
 */
import { STEER_NO_ACTIVE_TURN_CODE } from '@kortix/api-contract/runtime-relay'
import { stripInlineAttachmentBytes } from '../shared/inline-attachments'
import type { HarnessTurnResponse, HarnessTurnService, RuntimePromptInput } from '../contract/turns'
import { PromptRejected, parsePromptBody, type PiRuntime, type PromptInput } from './runtime'

const answer = (status: number, body: unknown): HarnessTurnResponse => ({ status, body })
const NOT_STARTED = answer(503, { error: 'pi runtime is not started' })

/** The runtime's prompt input, or the 400 that refuses the body. */
function toPrompt(input: RuntimePromptInput): PromptInput | HarnessTurnResponse {
  try {
    return parsePromptBody({
      ...(input.messageId ? { messageID: input.messageId } : {}),
      parts: input.parts,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })
  } catch (err) {
    return answer(400, { error: err instanceof Error ? err.message : String(err) })
  }
}

export function createPiTurnService(runtime: () => PiRuntime | null): HarnessTurnService {
  const transcriptOf = (rt: PiRuntime, sessionId: string) =>
    sessionId === rt.rootId ? rt.transcript : rt.childSession(sessionId)?.transcript ?? null

  return {
    async prompt(sessionId, input) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      // A subagent's child session is driven only by its parent's task tool.
      if (sessionId !== rt.rootId) return answer(rt.childSession(sessionId) ? 409 : 404, { error: 'not the session root' })
      const prompt = toPrompt(input)
      if ('status' in prompt) return prompt
      try {
        const admitted = rt.admit(prompt)
        void admitted.done.catch(() => {})
        return answer(202, { message_id: admitted.messageId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof PromptRejected && message.includes('already admitted')) return answer(200, { deduplicated: true })
        return answer(err instanceof PromptRejected ? 503 : 500, { error: message })
      }
    },

    async steer(sessionId, input) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      if (sessionId !== rt.rootId) return answer(404, { error: 'not the session root' })
      const prompt = toPrompt(input)
      if ('status' in prompt) return prompt
      if (!prompt.messageID) return answer(400, { error: 'message_id is required' })
      try {
        const steered = rt.steer({ ...prompt, messageID: prompt.messageID })
        if (steered === 'duplicate') return answer(200, { deduplicated: true })
        if (steered === 'no_turn') return answer(409, { code: STEER_NO_ACTIVE_TURN_CODE })
        return answer(202, { message_id: prompt.messageID, steered: true })
      } catch (err) {
        return answer(err instanceof PromptRejected ? 503 : 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },

    async abort(sessionId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      if (sessionId !== rt.rootId) return answer(404, { error: 'not the session root' })
      await rt.abort()
      return answer(200, true)
    },

    async readMessage(sessionId, messageId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const message = transcriptOf(rt, sessionId)?.messageById(messageId)
      if (!message) return answer(404, { error: 'unknown message' })
      const ref = (id: string, partId: string) =>
        `/kortix/part/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}/${encodeURIComponent(partId)}`
      return answer(200, stripInlineAttachmentBytes(message, ref).value)
    },

    async removeMessage(sessionId, messageId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      // A steered message the turn has not read is taken back out of its queue.
      const withdrawn = sessionId === rt.rootId ? rt.withdrawSteer(messageId) : null
      if (withdrawn === 'removed') return answer(200, true)
      if (withdrawn === 'read') return answer(409, { error: 'message is already running' })
      if (!transcriptOf(rt, sessionId)?.messageById(messageId)) return answer(404, { error: 'unknown message' })
      if (rt.activeTurnMessageId() === messageId) return answer(409, { error: 'message is already running' })
      return answer(409, { error: 'message deletion is not supported by the pi harness' })
    },

    async agents() {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const doc = rt.stateDoc() as { agents?: { value?: Array<Record<string, unknown>> } }
      const agents = (doc.agents?.value ?? []).map((agent) => ({
        name: agent.name,
        description: agent.description ?? null,
        mode: agent.mode ?? null,
      }))
      return answer(200, { agents })
    },
  }
}
