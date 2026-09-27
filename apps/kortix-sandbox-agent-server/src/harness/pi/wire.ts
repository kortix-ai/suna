/**
 * pi's event stream, reshaped into the OpenCode wire frames the product
 * already consumes (`{ type, properties }`, the input of the SDK's
 * `narrowChatEvent`). pi speaks the protocol the SDK already parses, which is
 * what keeps `useSession` and every chat surface unchanged.
 *
 * Stateful across one turn: parts accumulate, so a text delta emits BOTH the
 * full text so far (`message.part.updated`, transcript only — the store needs
 * the whole string for REST reads) and the append (`message.part.delta`, bus
 * only — the web client paints eagerly off deltas, the path OpenCode drives).
 * Putting both on the bus would render the text twice.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage as PiAssistantMessage, Usage } from '@earendil-works/pi-ai'
import type { WireFrame } from './transcript'

export type WireEmission = WireFrame & {
  /** Fold into the transcript, keep off the bus (the full-text twin of a delta). */
  transcriptOnly?: boolean
}

export interface WireAdapterOptions {
  sessionID: string
  /** Mint the id of the assistant message a turn is about to start. */
  mintMessageId: () => string
  /** The user message this assistant run answers. Read once at message start. */
  parentMessageId: () => string | null
  model: () => { providerID: string; modelID: string }
  agent: string
  workspace: string
  now?: () => number
  /** Out-of-band frame sink for parts reserved outside `translate` (see `toolRef`). */
  publish?: (frame: WireEmission) => void
}

/** OpenCode part ids are stable per (messageId, index). */
const partId = (messageId: string, index: number) => `${messageId}-p${index}`

/** Flatten pi's AgentToolResult into the plain text the UI expects. */
export function toolOutputText(result: unknown): string {
  if (typeof result === 'string') return result
  const blocks = (result as { content?: unknown } | null)?.content
  if (Array.isArray(blocks)) {
    return blocks
      .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
  }
  return result == null ? '' : JSON.stringify(result)
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The assistant `info` fields OpenCode's UserMessage/AssistantMessage contract requires. */
export function assistantContractFields(
  usage: Usage | undefined,
  options: { agent: string; workspace: string },
): Record<string, unknown> {
  return {
    agent: options.agent,
    mode: options.agent,
    path: { cwd: options.workspace, root: options.workspace },
    cost: finiteNumber(usage?.cost?.total),
    tokens: {
      input: finiteNumber(usage?.input),
      output: finiteNumber(usage?.output),
      reasoning: finiteNumber(usage?.reasoning),
      cache: { read: finiteNumber(usage?.cacheRead), write: finiteNumber(usage?.cacheWrite) },
    },
  }
}

/** OpenCode `AssistantMessage.error` for a terminal pi message, or undefined. */
export function assistantMessageError(
  message: Pick<PiAssistantMessage, 'stopReason' | 'errorMessage'>,
): { name: string; data: Record<string, unknown> } | undefined {
  const detail = typeof message.errorMessage === 'string' && message.errorMessage.trim() ? message.errorMessage : null
  if (message.stopReason === 'aborted') {
    return { name: 'MessageAbortedError', data: { message: detail ?? 'The message was aborted' } }
  }
  if (message.stopReason === 'error') {
    return { name: 'UnknownError', data: { message: detail ?? 'The model request failed' } }
  }
  if (message.stopReason === 'length') return { name: 'MessageOutputLengthError', data: {} }
  return undefined
}

export class PiWireAdapter {
  private readonly now: () => number
  private currentMessageId = ''
  private currentParentId: string | null = null
  private currentCreatedAt = 0
  private partCount = 0
  private textIndex = new Map<string, number>()
  private accum = new Map<string, string>()
  private partStartedAt = new Map<string, number>()
  private toolIndex = new Map<string, { partId: string; name: string; input: unknown; startedAt: number; endedAt?: number }>()

  constructor(private readonly opts: WireAdapterOptions) {
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * The tool part a pi tool call maps to (for permission/question `tool` refs).
   *
   * A permission prompt fires from `beforeToolCall`, which can run BEFORE pi
   * emits `tool_execution_start`; naming the tool here reserves the part so
   * the product attaches the prompt to the card it will render. The later
   * start event reuses the reservation.
   */
  toolRef(toolCallId: string, tool?: { name: string; args: unknown }): { messageID: string; callID: string } | undefined {
    let entry = this.toolIndex.get(toolCallId)
    if (!entry && tool && this.currentMessageId) {
      entry = { partId: partId(this.currentMessageId, this.partCount++), name: tool.name, input: tool.args, startedAt: this.now() }
      this.toolIndex.set(toolCallId, entry)
      this.opts.publish?.(this.toolPart(entry.partId, entry.name, { status: 'running', input: entry.input ?? {}, time: { start: entry.startedAt } }))
    }
    return entry ? { messageID: this.currentMessageId, callID: entry.partId } : undefined
  }

  get messageId(): string {
    return this.currentMessageId
  }

  translate(event: AgentEvent): WireEmission[] {
    const sessionID = this.opts.sessionID
    switch (event.type) {
      case 'agent_start':
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }]

      case 'message_start': {
        // Only ASSISTANT messages translate: the runtime publishes the user
        // message itself at admission, and pi's toolResult messages are carried
        // as tool PARTS on the assistant message.
        if (event.message.role !== 'assistant') return []
        this.toolIndex.clear()
        this.textIndex.clear()
        this.accum.clear()
        this.partStartedAt.clear()
        this.partCount = 0
        this.currentMessageId = this.opts.mintMessageId()
        this.currentParentId = this.opts.parentMessageId()
        this.currentCreatedAt = this.now()
        return [{ type: 'message.updated', properties: { sessionID, info: this.assistantInfo(event.message) } }]
      }

      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_start' || inner.type === 'text_delta' || inner.type === 'text_end') {
          const key = `text:${inner.contentIndex}`
          if (!this.textIndex.has(key)) this.textIndex.set(key, this.partCount++)
          const id = partId(this.currentMessageId, this.textIndex.get(key)!)
          const prev = this.accum.get(id) ?? ''
          const next = inner.type === 'text_delta' ? prev + inner.delta : inner.type === 'text_end' ? inner.content : prev
          this.accum.set(id, next)
          return this.textFrames({ id, partType: 'text', full: next, delta: inner.type === 'text_delta' ? inner.delta : null })
        }
        if (inner.type === 'thinking_start' || inner.type === 'thinking_delta' || inner.type === 'thinking_end') {
          const key = `think:${inner.contentIndex}`
          if (!this.textIndex.has(key)) this.textIndex.set(key, this.partCount++)
          const id = partId(this.currentMessageId, this.textIndex.get(key)!)
          const start = this.partStartedAt.get(id) ?? this.now()
          this.partStartedAt.set(id, start)
          const prev = this.accum.get(id) ?? ''
          const next = inner.type === 'thinking_delta' ? prev + inner.delta : inner.type === 'thinking_end' ? inner.content : prev
          this.accum.set(id, next)
          return this.textFrames({
            id,
            partType: 'reasoning',
            full: next,
            delta: inner.type === 'thinking_delta' ? inner.delta : null,
            time: { start, ...(inner.type === 'thinking_end' ? { end: this.now() } : {}) },
          })
        }
        return []
      }

      case 'tool_execution_start': {
        const reserved = this.toolIndex.get(event.toolCallId)
        const id = reserved?.partId ?? partId(this.currentMessageId, this.partCount++)
        const startedAt = reserved?.startedAt ?? this.now()
        this.toolIndex.set(event.toolCallId, { partId: id, name: event.toolName, input: event.args, startedAt })
        return [this.toolPart(id, event.toolName, { status: 'running', input: event.args ?? {}, time: { start: startedAt } })]
      }

      case 'tool_execution_update': {
        const t = this.toolIndex.get(event.toolCallId)
        if (!t || t.endedAt !== undefined) return []
        // Partial `details` ride along as metadata: a task part names its child session while it runs.
        const details = (event.partialResult as { details?: unknown } | null)?.details
        const partial = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {}
        return [
          this.toolPart(t.partId, t.name, {
            status: 'running',
            input: t.input ?? {},
            metadata: { ...partial, output: toolOutputText(event.partialResult) },
            time: { start: t.startedAt },
          }),
        ]
      }

      case 'tool_execution_end': {
        const t = this.toolIndex.get(event.toolCallId)
        if (!t) return []
        const output = toolOutputText(event.result)
        const endedAt = this.now()
        t.endedAt = endedAt
        const details = (event.result as { details?: unknown } | null)?.details
        const metadata = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {}
        return [
          this.toolPart(
            t.partId,
            t.name,
            event.isError
              ? { status: 'error', input: t.input ?? {}, error: output, time: { start: t.startedAt, end: endedAt } }
              : { status: 'completed', input: t.input ?? {}, output, title: t.name, metadata, time: { start: t.startedAt, end: endedAt } },
          ),
        ]
      }

      case 'message_end': {
        if (event.message.role !== 'assistant') return []
        const error = assistantMessageError(event.message)
        const out: WireEmission[] = [
          {
            type: 'message.updated',
            properties: {
              sessionID,
              info: { ...this.assistantInfo(event.message), time: { created: this.currentCreatedAt, completed: this.now() }, ...(error ? { error } : {}) },
            },
          },
        ]
        if (error && event.message.stopReason !== 'aborted') out.push({ type: 'session.error', properties: { sessionID, error } })
        return out
      }

      case 'agent_end':
        return [
          { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
          { type: 'session.idle', properties: { sessionID } },
        ]

      default:
        return []
    }
  }

  private assistantInfo(message: AgentMessage): Record<string, unknown> {
    const assistant = message as PiAssistantMessage
    const model = this.opts.model()
    return {
      id: this.currentMessageId,
      role: 'assistant',
      sessionID: this.opts.sessionID,
      ...(this.currentParentId ? { parentID: this.currentParentId } : {}),
      time: { created: this.currentCreatedAt },
      modelID: model.modelID,
      providerID: model.providerID,
      ...assistantContractFields(assistant.usage, { agent: this.opts.agent, workspace: this.opts.workspace }),
    }
  }

  private textFrames(input: {
    id: string
    partType: 'text' | 'reasoning'
    full: string
    delta: string | null
    time?: { start: number; end?: number }
  }): WireEmission[] {
    const sessionID = this.opts.sessionID
    const snapshot: WireEmission = {
      type: 'message.part.updated',
      properties: {
        sessionID,
        time: this.now(),
        part: {
          id: input.id,
          messageID: this.currentMessageId,
          sessionID,
          type: input.partType,
          text: input.full,
          ...(input.time ? { time: input.time } : {}),
        },
      },
    }
    if (!input.delta) return [snapshot]
    return [
      { ...snapshot, transcriptOnly: true },
      {
        type: 'message.part.delta',
        properties: { sessionID, messageID: this.currentMessageId, partID: input.id, field: 'text', delta: input.delta },
      },
    ]
  }

  private toolPart(id: string, tool: string, state: Record<string, unknown>): WireEmission {
    const sessionID = this.opts.sessionID
    return {
      type: 'message.part.updated',
      properties: {
        sessionID,
        time: this.now(),
        part: { id, messageID: this.currentMessageId, sessionID, type: 'tool', tool, callID: id, state },
      },
    }
  }
}
