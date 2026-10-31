/**
 * Claude Code's output as one pi model response.
 *
 * Claude Code streams the Anthropic API events of each model response (`stream_event`) and
 * then the complete assistant messages. Text and thinking stream from the events. A call of a
 * Kortix tool becomes a pi tool call (with the complete message's input as its arguments); a
 * call of any other tool is Claude Code's own business and is left out. Usage keeps the highest
 * count Claude Code reported for each response: it reports one response several times.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, TextContent, ThinkingContent, ToolCall, Usage } from '@earendil-works/pi-ai'
import { original } from './names'
import { CLAUDE_CONNECT_MESSAGE, CLAUDE_RECONNECT_MESSAGE } from './sdk'

type Block = { kind: 'text' | 'thinking' | 'tool'; index: number }

interface UsageCounts {
  input: number
  read: number
  write: number
  output: number
  reasoning: number
}

interface RawUsage {
  input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  output_tokens?: number | null
  output_tokens_details?: { thinking_tokens?: number } | null
}

export class ClaudeReply {
  readonly message: AssistantMessage
  private readonly blocks = new Map<string, Block>()
  private readonly streamed = new Set<string>()
  private readonly usage = new Map<string, UsageCounts>()
  private lastResponse: string | undefined
  private responseId = ''
  private started = false
  private rateLimited: { type?: string; resetsAt?: number } | undefined
  private assistantError: string | undefined
  /** The Claude transcript id of the last complete assistant message: the reply's checkpoint. */
  claudeMessageID: string | undefined
  /** Kortix tool calls in this reply, in order. */
  readonly toolCalls: ToolCall[] = []

  constructor(
    private readonly stream: AssistantMessageEventStream,
    private readonly model: Model<Api>,
    private readonly tools: readonly { name: string }[],
    private readonly subscription: () => boolean,
  ) {
    this.message = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.stream.push({ type: 'start', partial: this.message })
  }

  private add(part: TextContent | ThinkingContent | ToolCall): number {
    this.start()
    this.message.content.push(part)
    return this.message.content.length - 1
  }

  private updateUsage(id: string, raw: RawUsage | undefined): void {
    if (!raw) return
    const counts = this.usage.get(id) ?? { input: 0, read: 0, write: 0, output: 0, reasoning: 0 }
    if (!this.usage.has(id)) {
      this.usage.set(id, counts)
      this.lastResponse = id
    }
    counts.input = Math.max(counts.input, raw.input_tokens ?? 0)
    counts.read = Math.max(counts.read, raw.cache_read_input_tokens ?? 0)
    counts.write = Math.max(counts.write, raw.cache_creation_input_tokens ?? 0)
    counts.output = Math.max(counts.output, raw.output_tokens ?? 0)
    counts.reasoning = Math.max(counts.reasoning, raw.output_tokens_details?.thinking_tokens ?? 0)
    this.message.usage = this.snapshot()
  }

  /** Context size is the last call's input; output is the sum of every call of this reply. */
  private snapshot(): Usage {
    let output = 0
    let reasoning = 0
    for (const counts of this.usage.values()) {
      output += counts.output
      reasoning += counts.reasoning
    }
    const last = this.lastResponse ? this.usage.get(this.lastResponse) : undefined
    const input = last?.input ?? 0
    const cacheRead = last?.read ?? 0
    const cacheWrite = last?.write ?? 0
    // A subscription covers its usage; any other login is billed by Anthropic, not by Kortix.
    return { input, output, cacheRead, cacheWrite, reasoning, totalTokens: input + cacheRead + cacheWrite + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  }

  /** Feed one SDK message. */
  push(message: SDKMessage): void {
    if (message.type === 'rate_limit_event') {
      const info = (message as { rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number } }).rate_limit_info
      this.rateLimited = info?.status === 'rejected' ? { type: info.rateLimitType, resetsAt: info.resetsAt } : undefined
      return
    }
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) return this.event(message.event as StreamEvent)
    if (message.type === 'assistant' && message.parent_tool_use_id === null) return this.assistant(message)
  }

  private event(event: StreamEvent): void {
    switch (event.type) {
      case 'message_start':
        this.responseId = event.message.id
        this.streamed.add(this.responseId)
        this.message.responseId = this.responseId
        this.message.responseModel = event.message.model
        this.updateUsage(this.responseId, event.message.usage)
        this.start()
        return
      case 'content_block_start': {
        const key = `${this.responseId}:${event.index}`
        const block = event.content_block
        if (block.type === 'text') {
          const index = this.add({ type: 'text', text: '' })
          this.blocks.set(key, { kind: 'text', index })
          this.stream.push({ type: 'text_start', contentIndex: index, partial: this.message })
          if (block.text) this.textDelta(index, block.text)
        } else if (block.type === 'thinking') {
          const index = this.add({ type: 'thinking', thinking: '' })
          this.blocks.set(key, { kind: 'thinking', index })
          this.stream.push({ type: 'thinking_start', contentIndex: index, partial: this.message })
          if (block.thinking) this.thinkingDelta(index, block.thinking)
        } else if (block.type === 'tool_use' && block.id && block.name) {
          const name = original(block.name, this.tools)
          if (!name) return
          const index = this.add({ type: 'toolCall', id: block.id, name, arguments: {} })
          this.blocks.set(key, { kind: 'tool', index })
          this.stream.push({ type: 'toolcall_start', contentIndex: index, partial: this.message })
        }
        return
      }
      case 'content_block_delta': {
        const block = this.blocks.get(`${this.responseId}:${event.index}`)
        if (!block) return
        const delta = event.delta
        if (block.kind === 'text' && delta.type === 'text_delta' && delta.text) this.textDelta(block.index, delta.text)
        else if (block.kind === 'thinking' && delta.type === 'thinking_delta' && delta.thinking) this.thinkingDelta(block.index, delta.thinking)
        else if (block.kind === 'thinking' && delta.type === 'signature_delta') {
          const part = this.message.content[block.index] as ThinkingContent
          part.thinkingSignature = (part.thinkingSignature ?? '') + (delta.signature ?? '')
        } else if (block.kind === 'tool' && delta.type === 'input_json_delta' && delta.partial_json) {
          this.stream.push({ type: 'toolcall_delta', contentIndex: block.index, delta: delta.partial_json, partial: this.message })
        }
        return
      }
      case 'content_block_stop': {
        const key = `${this.responseId}:${event.index}`
        const block = this.blocks.get(key)
        if (!block) return
        const part = this.message.content[block.index]!
        if (part.type === 'text') this.stream.push({ type: 'text_end', contentIndex: block.index, content: part.text, partial: this.message })
        else if (part.type === 'thinking') this.stream.push({ type: 'thinking_end', contentIndex: block.index, content: part.thinking, partial: this.message })
        // A tool call ends when the complete assistant message brings its input.
        if (block.kind !== 'tool') this.blocks.delete(key)
        return
      }
      case 'message_delta':
        this.updateUsage(this.responseId, event.usage)
        if (event.delta?.stop_reason) this.message.rawStopReason = event.delta.stop_reason
        return
    }
  }

  private textDelta(index: number, delta: string): void {
    ;(this.message.content[index] as TextContent).text += delta
    this.stream.push({ type: 'text_delta', contentIndex: index, delta, partial: this.message })
  }

  private thinkingDelta(index: number, delta: string): void {
    ;(this.message.content[index] as ThinkingContent).thinking += delta
    this.stream.push({ type: 'thinking_delta', contentIndex: index, delta, partial: this.message })
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    // A synthetic API error message is a diagnostic, not an answer.
    if (message.error) {
      this.assistantError = String(message.error)
      return
    }
    this.claudeMessageID = message.uuid
    const api = message.message as unknown as { id: string; content: ApiBlock[]; usage?: RawUsage }
    this.updateUsage(api.id, api.usage)
    const streamed = this.streamed.has(api.id)
    api.content.forEach((block) => {
      if (block.type === 'tool_use' && block.id && block.name) {
        const id = block.id
        const name = original(block.name, this.tools)
        if (!name) return
        const args = (block.input && typeof block.input === 'object' ? block.input : {}) as ToolCall['arguments']
        let index = this.message.content.findIndex((part) => part.type === 'toolCall' && part.id === id)
        if (index === -1) {
          index = this.add({ type: 'toolCall', id, name, arguments: args })
          this.stream.push({ type: 'toolcall_start', contentIndex: index, partial: this.message })
        }
        const call = this.message.content[index] as ToolCall
        call.arguments = args
        if (!this.toolCalls.some((existing) => existing.id === call.id)) {
          this.toolCalls.push(call)
          this.stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: call, partial: this.message })
        }
        return
      }
      // A complete message repeats what streamed; it carries content only when nothing streamed.
      if (streamed) return
      if (block.type === 'text' && block.text) {
        const index = this.add({ type: 'text', text: '' })
        this.stream.push({ type: 'text_start', contentIndex: index, partial: this.message })
        this.textDelta(index, block.text)
        this.stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: this.message })
      } else if (block.type === 'thinking' && block.thinking) {
        const index = this.add({ type: 'thinking', thinking: '', thinkingSignature: block.signature })
        this.stream.push({ type: 'thinking_start', contentIndex: index, partial: this.message })
        this.thinkingDelta(index, block.thinking)
        this.stream.push({ type: 'thinking_end', contentIndex: index, content: block.thinking, partial: this.message })
      }
    })
  }

  /** The step ended at Kortix tool calls: Claude waits for their results. */
  finishTools(): AssistantMessage {
    this.message.stopReason = 'toolUse'
    this.start()
    this.stream.push({ type: 'done', reason: 'toolUse', message: this.message })
    this.stream.end(this.message)
    return this.message
  }

  /** The turn ended. A result that is an error ends the stream with that error. */
  finishResult(result: Extract<SDKMessage, { type: 'result' }>): AssistantMessage {
    const error = this.resultError(result)
    if (error) return this.fail(error)
    if (this.usage.size <= 1) this.updateUsage(this.lastResponse ?? 'result', result.usage as RawUsage)
    const reason = result.subtype === 'success' && result.stop_reason === 'max_tokens' ? 'length' : 'stop'
    this.message.stopReason = reason
    this.start()
    this.stream.push({ type: 'done', reason, message: this.message })
    this.stream.end(this.message)
    return this.message
  }

  fail(error: unknown, reason: 'error' | 'aborted' = 'error'): AssistantMessage {
    this.message.stopReason = reason
    this.message.errorMessage = error instanceof Error ? error.message : String(error)
    this.start()
    this.stream.push({ type: 'error', reason, error: this.message })
    this.stream.end(this.message)
    return this.message
  }

  /** The user-facing text of a failed turn, or undefined when it succeeded. Claude Code already retried. */
  private resultError(result: Extract<SDKMessage, { type: 'result' }>): Error | undefined {
    const status = result.subtype === 'success' ? ((result as { api_error_status?: number }).api_error_status ?? undefined) : undefined
    const httpError = status !== undefined && status >= 400
    if (result.subtype === 'success' && !result.is_error && !httpError) return undefined
    const text = (result.subtype === 'success' ? result.result : (result as { errors?: string[] }).errors?.join('\n') ?? '')
      .replaceAll('Please run /login', 'Reconnect your Claude subscription in Kortix')
    const failure =
      status !== undefined && status >= 500
        ? `${status === 529 ? 'Anthropic is overloaded (529).' : `Anthropic returned HTTP ${status}.`} Claude Code used up its retries. Try again shortly.`
        : text
    const limited = this.assistantError === 'rate_limit' || (this.rateLimited && status === 429)
    const window = this.rateLimited?.type?.replaceAll('_', ' ')
    const limit = limited && !failure ? `Your Claude ${this.subscription() ? 'subscription' : 'account'} limit is reached${window ? ` (${window})` : ''}.` : failure
    const reset = limited && this.rateLimited?.resetsAt ? ` It resets at ${new Date(this.rateLimited.resetsAt * 1000).toISOString()}.` : ''
    const billing = this.assistantError === 'billing_error' ? ' Check your Claude plan and its extra-usage settings.' : ''
    // Anthropic refused the login (revoked, expired), or the gateway found only accounts that
    // need reconnection: the person reconnects Claude in Kortix.
    if (this.assistantError === 'authentication_failed' || status === 401 || /Claude accounts? .*needs? reconnection/.test(text)) {
      return new ClaudeTurnError(CLAUDE_RECONNECT_MESSAGE, this.assistantError, status)
    }
    // The gateway found no Claude account for this session (llm-gateway claude-code passthrough).
    if (text.includes('Connect Claude to use this model')) return new ClaudeTurnError(CLAUDE_CONNECT_MESSAGE, this.assistantError, status)
    const message = limit + reset + billing
    if (message) return new ClaudeTurnError(message, this.assistantError, status)
    return new ClaudeTurnError(status ? `Claude Code could not finish its reply (HTTP ${status})` : 'Claude Code could not finish its reply', this.assistantError, status)
  }
}

/** A failed Claude turn: `code` is Claude Code's error kind (`authentication_failed`, `rate_limit`, `billing_error`, …). */
export class ClaudeTurnError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number | undefined,
  ) {
    super(message)
    this.name = 'ClaudeTurnError'
  }
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

/** An Anthropic content block, loosely: Claude Code passes the API's blocks through. */
interface ApiBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: unknown
}

interface ApiDelta {
  type: string
  text?: string
  thinking?: string
  signature?: string
  partial_json?: string
}

type StreamEvent =
  | { type: 'message_start'; message: { id: string; model: string; usage?: RawUsage } }
  | { type: 'content_block_start'; index: number; content_block: ApiBlock }
  | { type: 'content_block_delta'; index: number; delta: ApiDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: RawUsage }
  | { type: 'message_stop' }
