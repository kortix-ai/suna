/**
 * The Kortix turn verbs on pi, answered in-process by the runtime: admit a
 * prompt, abort the run, read or retract a message, list the compiled agent set,
 * and the session-log actions (answer, compact, run a command, grants, log reads).
 */
import { MESSAGE_READ_CODE, STEER_NO_ACTIVE_TURN_CODE, type RuntimeCommandInfo } from '@kortix/api-contract/runtime-relay'
import type { SessionLogMessage } from '@kortix/api-contract/session-log'
import { stripInlineAttachmentBytes } from '../shared/inline-attachments'
import type { HarnessTurnResponse, HarnessTurnService, RuntimePromptInput } from '../contract/turns'
import { CommandNotEnabled, PromptRejected, parsePromptBody, type PiRuntime, type PromptInput } from './runtime'
import { sessionLogView } from '../shared/session-log-journal'
import { piQueued, piSessionLog } from './session-log'

const answer = (status: number, body: unknown): HarnessTurnResponse => ({ status, body })
const NOT_STARTED = answer(503, { error: 'pi runtime is not started' })
const READ = answer(409, { code: MESSAGE_READ_CODE, error: 'a model call read this message' })
const OK = answer(200, { ok: true })
const NOT_ROOT = answer(404, { error: 'not the session root' })

/** The box's own session log, built from the runtime's store, and its queued prompts; null while the runtime is down. */
function sessionLogOf(rt: PiRuntime) {
  const snapshot = rt.sessionLogSnapshot()
  return snapshot ? { ...piSessionLog(snapshot), queued: piQueued(snapshot) } : null
}

/**
 * The `mime` the log's own attachment records give this digest: an attachment
 * block, or an attachment in a tool result's content. A tool call's input is
 * the model's own JSON and never types the bytes.
 */
function mimeOf(log: { threads?: Array<{ messages?: Array<{ blocks?: unknown[] }> }> }, sha256: string): string | null {
  const inItems = (items: unknown[]): string | null => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const block = item as Record<string, unknown>
      if (block.type === 'attachment') {
        if (block.sha256 === sha256 && typeof block.mime === 'string') return block.mime
        continue
      }
      if (block.type !== 'tool_call' || !block.result || typeof block.result !== 'object') continue
      const result = block.result as Record<string, unknown>
      for (const list of [result.content, result.model_content]) {
        const found = Array.isArray(list) ? inItems(list) : null
        if (found) return found
      }
    }
    return null
  }
  for (const thread of log.threads ?? []) {
    for (const message of thread.messages ?? []) {
      const found = inItems(message.blocks ?? [])
      if (found) return found
    }
  }
  return null
}

/** The runtime's prompt input, or the 400 that refuses the body. */
function toPrompt(input: RuntimePromptInput): PromptInput | HarnessTurnResponse {
  try {
    return parsePromptBody({
      ...(input.messageId ? { messageID: input.messageId } : {}),
      parts: input.parts,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
      ...(input.noReply ? { noReply: true } : {}),
      ...(input.system ? { system: input.system } : {}),
    })
  } catch (err) {
    return answer(400, { error: err instanceof Error ? err.message : String(err) })
  }
}

export function createPiTurnService(runtime: () => PiRuntime | null): HarnessTurnService {
  const transcriptOf = (rt: PiRuntime, sessionId: string) =>
    sessionId === rt.rootId ? rt.transcript : rt.childSession(sessionId)?.transcript ?? null
  /** A subagent's child session is driven by its parent's task tool: every message in it was read. */
  const retract = (rt: PiRuntime, sessionId: string, messageId: string) =>
    sessionId === rt.rootId ? rt.retract(messageId) : transcriptOf(rt, sessionId)?.messageById(messageId) ? 'read' : null

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
        const steered = await rt.steer({ ...prompt, messageID: prompt.messageID })
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

    // pi removes only what no model call has read, so a removal is a retract.
    async removeMessage(sessionId, messageId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const outcome = retract(rt, sessionId, messageId)
      if (outcome === 'retracted') return answer(200, true)
      return outcome === 'read' ? READ : answer(404, { error: 'unknown message' })
    },

    async retractMessage(sessionId, messageId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const outcome = retract(rt, sessionId, messageId)
      if (outcome === 'retracted') return answer(200, { retracted: true })
      return outcome === 'read' ? READ : answer(404, { error: 'unknown message' })
    },

    async replyPermission(requestId, body) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      return rt.permissions.reply(requestId, body.reply) ? OK : answer(404, { error: 'no such permission request' })
    },

    async replyQuestion(requestId, answers) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      return rt.questions.reply(requestId, answers) ? OK : answer(404, { error: 'no such question' })
    },

    async rejectQuestion(requestId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      return rt.questions.reject(requestId) ? OK : answer(404, { error: 'no such question' })
    },

    async compact(sessionId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      if (sessionId !== rt.rootId) return NOT_ROOT
      try {
        rt.compact()
      } catch (err) {
        return answer(503, { error: err instanceof Error ? err.message : String(err) })
      }
      return answer(202, { ok: true })
    },

    async command(sessionId, body) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      if (sessionId !== rt.rootId) return NOT_ROOT
      let prompt: PromptInput
      try {
        prompt = rt.commandPrompt({
          command: body.name,
          arguments: body.arguments,
          ...(body.agent ? { agent: body.agent } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.variant ? { variant: body.variant } : {}),
          ...(body.message_id ? { messageID: body.message_id } : {}),
        })
      } catch (err) {
        if (err instanceof CommandNotEnabled) return answer(403, { error: 'command_not_enabled', command: err.command, agent: err.agent })
        return answer(400, { error: err instanceof Error ? err.message : String(err) })
      }
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

    async setGrants(sessionId, grants) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      if (sessionId !== rt.rootId) return NOT_ROOT
      return answer(200, { grants: rt.setGrants(grants) })
    },

    async commands() {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      // A v3 command lists the agents it is enabled for; a pi prompt template has no such list.
      const commands: RuntimeCommandInfo[] = rt.commandList().map((command) => ({
        name: command.name,
        description: command.description || null,
        // A workflow command (`/deep-research`) lists as a template: a prompt the runtime expands.
        source: command.source === 'skill' ? 'skill' : command.source === 'command' && command.agents ? 'command' : 'template',
        ...(command.agents ? { agents: command.agents } : {}),
      }))
      return answer(200, { commands })
    },

    async pending() {
      const rt = runtime()
      return rt ? answer(200, rt.pendingNow()) : NOT_STARTED
    },

    async readLog({ threadId, afterSeq, beforeSeq, limit }) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const exported = sessionLogOf(rt)
      if (!exported) return NOT_STARTED
      const id = threadId ?? rt.rootId
      const { threads, ...session } = exported.log
      const thread = threads.find((t) => t.thread_id === id)
      if (!thread) return answer(404, { error: 'unknown thread' })
      // As apps/api stores the log (its seqs, its session fields), then the queued prompts at the queued seq.
      const view = sessionLogView()
      const queued = id === rt.rootId ? exported.queued : []
      const ordered = [...thread.messages.map((m) => view.message(m)), ...queued].sort((a, b) => a.seq - b.seq)
      let messages: SessionLogMessage[]
      let hasMore: boolean
      if (afterSeq !== null) {
        const after = ordered.filter((m) => m.seq > afterSeq)
        messages = after.slice(0, limit)
        hasMore = after.length > limit
      } else {
        const before = beforeSeq === null ? ordered : ordered.filter((m) => m.seq < beforeSeq)
        messages = before.slice(-limit)
        hasMore = before.length > limit
      }
      return answer(200, {
        session: view.session(session),
        generation: view.generation,
        threads: threads.map(({ messages: _messages, ...head }) => head),
        thread_id: id,
        messages,
        has_more: hasMore,
      })
    },

    async readLogMessage(messageId) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const exported = sessionLogOf(rt)
      if (!exported) return NOT_STARTED
      for (const thread of exported.log.threads) {
        const message = thread.messages.find((m) => m.message_id === messageId)
        if (message) return answer(200, sessionLogView().message(message))
      }
      const queued = exported.queued.find((m) => m.message_id === messageId)
      return queued ? answer(200, queued) : answer(404, { error: 'unknown message' })
    },

    async readBlob(sha256) {
      const rt = runtime()
      const exported = rt ? sessionLogOf(rt) : null
      const data = exported?.images.get(sha256)
      if (data === undefined) return null
      return { bytes: Buffer.from(data, 'base64'), mime: mimeOf(exported!.log, sha256) ?? 'application/octet-stream' }
    },

    async workflows() {
      const rt = runtime()
      return rt ? answer(200, { runs: rt.workflowList() }) : NOT_STARTED
    },

    async controlWorkflow(runId, body) {
      const rt = runtime()
      if (!rt) return NOT_STARTED
      const result = rt.controlWorkflow(runId, body)
      return answer(result.status, result.body)
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
