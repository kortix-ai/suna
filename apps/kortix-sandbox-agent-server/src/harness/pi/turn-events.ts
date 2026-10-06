/**
 * pi's agent events, emitted as Kortix session events
 * (`kortix.transcript.v1`, `@kortix/api-contract/transcript`): the frames the
 * SDK's `narrowChatEvent` reads, the transcript stores, and apps/api relays.
 *
 * Stateful across one turn: parts accumulate, so a text delta emits BOTH the
 * full text so far (`message.part.updated`, transcript only — the store needs
 * the whole string for REST reads) and the append (`message.part.delta`, bus
 * only — the web client paints eagerly off deltas).
 * Putting both on the bus would render the text twice.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage as PiAssistantMessage, Usage } from '@earendil-works/pi-ai'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type {
  KortixAssistantMessageInfo,
  KortixMessageError,
  KortixSessionEvent,
  KortixToolState,
  RuntimeToolRef,
} from '@kortix/api-contract/transcript'
import { turnErrorCode } from '../shared/turn-relay'

export type TurnEventEmission = KortixSessionEvent & {
  /** Fold into the transcript, keep off the bus (the full-text twin of a delta). */
  transcriptOnly?: boolean
}

export interface TurnEventsOptions {
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
  publish?: (frame: TurnEventEmission) => void
  /**
   * The retry a failed assistant message gets (transient-retry.ts), or null.
   * A message that will be retried ends without its error, and its run ends in
   * the `retry` status instead of idle: the turn is not over.
   */
  retryPlan?: (message: AgentMessage) => { attempt: number; message: string; next: number } | null
  /**
   * pi compacts the conversation and retries this failed message (a context
   * overflow, or a reply cut by the length limit). Like a retry, the message
   * ends without its error and the run stays busy; `settleRetry` publishes the
   * error when the recovery never came.
   */
  recovers?: (message: AgentMessage) => boolean
}

/** Part ids are stable per (messageId, index). */
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

/** A tool call's arguments as the part's `input` object. */
function toolInput(args: unknown): { [key: string]: unknown } {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as { [key: string]: unknown }) : {}
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The usage and placement fields of an assistant message's `info`. */
export function assistantInfoFields(
  usage: Usage | undefined,
  options: { agent: string; workspace: string },
): Pick<KortixAssistantMessageInfo, 'agent' | 'mode' | 'path' | 'cost' | 'tokens'> {
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

/** The HTTP status pi-ai puts first in a provider error's text (`"429: …"`, `"402 Payment Required"`). */
function errorStatus(text: string | null): number | undefined {
  const match = text ? /^([45]\d\d)\b/.exec(text) : null
  return match ? Number(match[1]) : undefined
}

/** The `error` of a terminal pi assistant message, with its `TurnErrorCode`, or undefined. */
export function assistantMessageError(
  message: Pick<PiAssistantMessage, 'stopReason' | 'errorMessage'>,
): KortixMessageError | undefined {
  const detail = typeof message.errorMessage === 'string' && message.errorMessage.trim() ? message.errorMessage.trim() : null
  if (message.stopReason === 'aborted') {
    return { name: 'MessageAbortedError', data: { message: detail ?? 'The message was aborted' }, code: 'aborted' }
  }
  if (message.stopReason === 'length') return { name: 'MessageOutputLengthError', data: {}, code: 'output_length' }
  if (message.stopReason !== 'error') return undefined
  // pi-ai's own provider patterns; with no context window it reads only the error text.
  if (isContextOverflow(message as PiAssistantMessage)) {
    return { name: 'ContextOverflowError', data: { message: detail ?? 'The conversation is too long for the model' }, code: 'context_length' }
  }
  const statusCode = errorStatus(detail)
  return {
    name: 'UnknownError',
    data: { message: detail ?? 'The model request failed', ...(statusCode ? { statusCode } : {}) },
    code: turnErrorCode({ statusCode }),
  }
}

export class PiTurnEvents {
  private readonly now: () => number
  private currentMessageId = ''
  private currentParentId: string | null = null
  private currentCreatedAt = 0
  private partCount = 0
  private textIndex = new Map<string, number>()
  private accum = new Map<string, string>()
  private partStartedAt = new Map<string, number>()
  private toolIndex = new Map<string, { partId: string; name: string; input: unknown; startedAt: number; endedAt?: number }>()
  /** The last assistant message of this run failed and will be retried. */
  private retrying: { attempt: number; message: string; next: number } | null = null
  /** The error withheld from a message pi is about to recover from. */
  private withheld: KortixMessageError | null = null
  private announced = false
  /** The finished info of the last assistant message, without its error. */
  private lastInfo: KortixAssistantMessageInfo | null = null

  constructor(private readonly opts: TurnEventsOptions) {
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
  toolRef(toolCallId: string, tool?: { name: string; args: unknown }): RuntimeToolRef | undefined {
    let entry = this.toolIndex.get(toolCallId)
    if (!entry && tool && this.currentMessageId) {
      entry = { partId: partId(this.currentMessageId, this.partCount++), name: tool.name, input: tool.args, startedAt: this.now() }
      this.toolIndex.set(toolCallId, entry)
      this.opts.publish?.(this.toolPart(entry.partId, entry.name, { status: 'running', input: toolInput(entry.input), time: { start: entry.startedAt } }))
    }
    return entry ? { messageID: this.currentMessageId, callID: entry.partId } : undefined
  }

  get messageId(): string {
    return this.currentMessageId
  }

  translate(event: AgentEvent): TurnEventEmission[] {
    const sessionID = this.opts.sessionID
    switch (event.type) {
      case 'agent_start':
        this.retrying = null
        this.withheld = null
        this.announced = false
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
        return [this.toolPart(id, event.toolName, { status: 'running', input: toolInput(event.args), time: { start: startedAt } })]
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
            input: toolInput(t.input),
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
              ? { status: 'error', input: toolInput(t.input), error: output, time: { start: t.startedAt, end: endedAt } }
              : { status: 'completed', input: toolInput(t.input), output, title: t.name, metadata, time: { start: t.startedAt, end: endedAt } },
          ),
        ]
      }

      case 'message_end': {
        if (event.message.role !== 'assistant') return []
        this.retrying = (event.message as PiAssistantMessage).stopReason === 'error' ? (this.opts.retryPlan?.(event.message) ?? null) : null
        const failure = this.retrying ? undefined : assistantMessageError(event.message)
        this.withheld = failure && failure.code !== 'aborted' && this.opts.recovers?.(event.message) ? failure : null
        if (this.withheld) this.retrying = { attempt: 1, message: 'Compacting the conversation to continue.', next: this.now() }
        const error = this.withheld ? undefined : failure
        this.lastInfo = { ...this.assistantInfo(event.message), time: { created: this.currentCreatedAt, completed: this.now() } }
        const out: TurnEventEmission[] = [{ type: 'message.updated', properties: { sessionID, info: { ...this.lastInfo, ...(error ? { error } : {}) } } }]
        if (error && event.message.stopReason !== 'aborted') out.push({ type: 'session.error', properties: { sessionID, error } })
        return out
      }

      case 'agent_end': {
        const retrying = this.retrying
        this.retrying = null
        if (retrying) {
          this.announced = true
          return [{ type: 'session.status', properties: { sessionID, status: { type: 'retry', ...retrying } } }]
        }
        return this.idleFrames()
      }

      default:
        return []
    }
  }

  /**
   * A run announced a retry that never started (aborted in the backoff): the
   * frames that end the run for good. Empty when no retry is pending.
   */
  settleRetry(): TurnEventEmission[] {
    if (!this.announced) return []
    this.announced = false
    const error = this.withheld
    this.withheld = null
    if (!error) return this.idleFrames()
    const sessionID = this.opts.sessionID
    return [
      { type: 'message.updated', properties: { sessionID, info: { ...this.lastInfo!, error } } },
      { type: 'session.error', properties: { sessionID, error } },
      ...this.idleFrames(),
    ]
  }

  private idleFrames(): TurnEventEmission[] {
    const sessionID = this.opts.sessionID
    return [
      { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID } },
    ]
  }

  private assistantInfo(message: AgentMessage): KortixAssistantMessageInfo {
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
      ...assistantInfoFields(assistant.usage, { agent: this.opts.agent, workspace: this.opts.workspace }),
    }
  }

  private textFrames(input: {
    id: string
    partType: 'text' | 'reasoning'
    full: string
    delta: string | null
    time?: { start: number; end?: number }
  }): TurnEventEmission[] {
    const sessionID = this.opts.sessionID
    const base = { id: input.id, messageID: this.currentMessageId, sessionID, text: input.full }
    const snapshot: TurnEventEmission = {
      type: 'message.part.updated',
      properties: {
        sessionID,
        time: this.now(),
        part:
          input.partType === 'reasoning'
            ? { ...base, type: 'reasoning', time: input.time ?? { start: this.now() } }
            : { ...base, type: 'text', ...(input.time ? { time: input.time } : {}) },
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

  private toolPart(id: string, tool: string, state: KortixToolState): TurnEventEmission {
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
