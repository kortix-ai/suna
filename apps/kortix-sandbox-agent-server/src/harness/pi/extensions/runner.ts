/**
 * System extensions: code compiled into kortixd that extends every pi session.
 *
 * An extension is pi's own shape — `(pi) => void`, `pi.on(event, handler)`,
 * `pi.registerTool(definition)` — so one written here runs unchanged under
 * pi-coding-agent later. pi's `ExtensionRunner` cannot be reused: it needs
 * pi-coding-agent's session manager, model registry and TUI theme (+52 ms
 * import, +10.45 MB). Every pi event is a thin map onto a hook of the core
 * `Agent` this harness already owns, so this runner is that map and no more.
 *
 * Supported: the events in `ExtensionEvents` and `registerTool`. Anything else
 * pi offers (commands, shortcuts, flags, renderers, providers, the session
 * manager, `ctx.ui`) is absent, so an extension that calls it throws during
 * load and is skipped — the runtime starts without it and says so.
 *
 * Scope: tool, context and provider hooks run for the root session AND its
 * child sessions (a guard must not be bypassed by delegating). Lifecycle
 * events (`session_*`, `before_agent_start`, agent events) are root-only.
 */
import type { AfterToolCallResult, AgentEvent, AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import { logger } from '../../../logger'

/** Kortix host capabilities. Not part of pi's ExtensionAPI; a portable extension never touches it. */
export interface KortixHost {
  /** The compiled agent config's `agent` map (`KORTIX_COMPILED_AGENT_CONFIG`). */
  compiledAgents(): Record<string, { description?: string; mode?: string; model?: string; variant?: string; prompt?: string; disable?: boolean; permission?: unknown }>
  /** Run one prompt in a child session of this session and return its final answer. */
  spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult>
}

export interface SpawnSessionInput {
  /** Continue this existing child session instead of creating one. */
  sessionId?: string
  title: string
  /** The agent name the child's messages carry. */
  agent: string
  /** Base system prompt; the runtime appends the workspace, skills and tool list. */
  systemPrompt: string
  /** `provider/model` ref; the parent's model when absent. */
  model?: string
  variant?: string
  /** Workspace tool names the child may use; all of them when absent. */
  tools?: string[]
  /** OpenCode permission config for the child's tools. */
  permission?: unknown
  prompt: string
  signal?: AbortSignal
  /** Called once the child exists, before its model runs. */
  onSession?: (session: { sessionId: string; model: { providerID: string; modelID: string } }) => void
}

export interface SpawnSessionResult {
  sessionId: string
  status: 'completed' | 'error' | 'aborted'
  text: string
  error?: string
  model: { providerID: string; modelID: string }
}

export interface ExtensionContext {
  cwd: string
  hasUI: false
  /** The running turn's abort signal, when a turn runs. */
  signal: AbortSignal | undefined
  getSystemPrompt(): string
  kortix: KortixHost
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string
  label: string
  description: string
  parameters: TParams
  /** `parallel` lets a batch made only of parallel tools run concurrently (pi's per-tool override). */
  executionMode?: 'sequential' | 'parallel'
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>
}

type ToolContent = AfterToolCallResult['content']

export interface ExtensionEvents {
  session_start: { event: { type: 'session_start'; reason: 'startup' | 'reload' }; result: void }
  session_shutdown: { event: { type: 'session_shutdown' }; result: void }
  before_agent_start: { event: { type: 'before_agent_start'; prompt: string; systemPrompt: string }; result: { systemPrompt?: string } | void }
  tool_call: { event: { type: 'tool_call'; toolName: string; toolCallId: string; input: Record<string, unknown> }; result: BeforeToolCallResult | void }
  tool_result: {
    event: { type: 'tool_result'; toolName: string; toolCallId: string; input: Record<string, unknown>; content: ToolContent; details: unknown; isError: boolean }
    result: AfterToolCallResult | void
  }
  context: { event: { type: 'context'; messages: AgentMessage[] }; result: { messages?: AgentMessage[] } | void }
  before_provider_request: { event: { type: 'before_provider_request'; payload: unknown }; result: unknown }
  agent_start: { event: Extract<AgentEvent, { type: 'agent_start' }>; result: void }
  agent_end: { event: Extract<AgentEvent, { type: 'agent_end' }>; result: void }
  turn_start: { event: Extract<AgentEvent, { type: 'turn_start' }>; result: void }
  turn_end: { event: Extract<AgentEvent, { type: 'turn_end' }>; result: void }
  message_start: { event: Extract<AgentEvent, { type: 'message_start' }>; result: void }
  message_update: { event: Extract<AgentEvent, { type: 'message_update' }>; result: void }
  message_end: { event: Extract<AgentEvent, { type: 'message_end' }>; result: void }
  tool_execution_start: { event: Extract<AgentEvent, { type: 'tool_execution_start' }>; result: void }
  tool_execution_update: { event: Extract<AgentEvent, { type: 'tool_execution_update' }>; result: void }
  tool_execution_end: { event: Extract<AgentEvent, { type: 'tool_execution_end' }>; result: void }
}

type EventName = keyof ExtensionEvents
type Handler<E extends EventName> = (
  event: ExtensionEvents[E]['event'],
  ctx: ExtensionContext,
) => ExtensionEvents[E]['result'] | Promise<ExtensionEvents[E]['result']>

export interface ExtensionAPI {
  on<E extends EventName>(event: E, handler: Handler<E>): void
  registerTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>): void
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>

export interface SystemExtension {
  name: string
  factory: ExtensionFactory
}

export interface ExtensionHost {
  cwd: string
  systemPrompt: () => string
  kortix: KortixHost
}

interface Registered<T> {
  extension: string
  value: T
}

/** The Agent options the runner contributes; empty when no extension listens. */
export interface ExtensionAgentHooks {
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  onPayload?: (payload: unknown, model: unknown) => Promise<unknown>
  afterToolCall?: (context: { toolCall: { id: string; name: string }; args: unknown; result: AgentToolResult<any>; isError: boolean }, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>
}

export class ExtensionRunner {
  private readonly handlers = new Map<EventName, Array<Registered<Handler<any>>>>()
  private readonly tools = new Map<string, Registered<ToolDefinition<any, any>>>()
  private readonly loaded: string[] = []
  private readonly failed: Array<{ name: string; error: string }> = []

  private constructor(private readonly host: ExtensionHost) {}

  /** Run every factory. A factory that throws is skipped with everything it registered. */
  static async load(extensions: readonly SystemExtension[], host: ExtensionHost): Promise<ExtensionRunner> {
    const runner = new ExtensionRunner(host)
    for (const extension of extensions) {
      // Registrations stay pending until the factory returns; after that the
      // API writes live, so a `session_start` handler can register a tool.
      let pending: Array<() => void> | null = []
      const apply = (change: () => void) => (pending ? pending.push(change) : change())
      const api: ExtensionAPI = {
        on: (event, handler) => apply(() => runner.add(event, { extension: extension.name, value: handler as Handler<any> })),
        registerTool: (tool) => apply(() => runner.tools.set(tool.name, { extension: extension.name, value: tool })),
      }
      try {
        await extension.factory(api)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        runner.failed.push({ name: extension.name, error })
        logger.error('[pi] system extension failed to load; skipped', { extension: extension.name, err: error })
        continue
      }
      for (const change of pending) change()
      pending = null
      runner.loaded.push(extension.name)
    }
    return runner
  }

  status(): { loaded: string[]; failed: Array<{ name: string; error: string }> } {
    return { loaded: [...this.loaded], failed: [...this.failed] }
  }

  has(event: EventName): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0
  }

  context(signal?: AbortSignal): ExtensionContext {
    return { cwd: this.host.cwd, hasUI: false, signal, getSystemPrompt: this.host.systemPrompt, kortix: this.host.kortix }
  }

  /** Registered tools, bound to the Agent's tool signature. A later registration of a name wins. */
  agentTools(): AgentTool<any, any>[] {
    return [...this.tools.values()].map(({ value: tool }) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      executionMode: tool.executionMode ?? 'sequential',
      execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, this.context(signal)),
    }))
  }

  /** Notification events: every handler runs, a failure is logged and never reaches the agent. */
  async emit<E extends EventName>(event: ExtensionEvents[E]['event'] & { type: E }, signal?: AbortSignal): Promise<void> {
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        await handler.value(event, this.context(signal))
      } catch (err) {
        logger.warn('[pi] system extension handler failed', { extension: handler.extension, event: event.type, err: (err as Error).message })
      }
    }
  }

  /** `tool_call`: the first block wins. A handler that throws blocks the call — a guard must fail closed. */
  async toolCall(event: ExtensionEvents['tool_call']['event'], signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
    for (const handler of this.handlers.get('tool_call') ?? []) {
      try {
        const result = (await handler.value(event, this.context(signal))) as BeforeToolCallResult | undefined
        if (result?.block) return result
      } catch (err) {
        return { block: true, reason: `Extension ${handler.extension} failed, blocking execution: ${(err as Error).message}` }
      }
    }
    return undefined
  }

  /** `before_agent_start`: system prompt changes chain through handlers in load order. */
  async beforeAgentStart(prompt: string, systemPrompt: string, signal?: AbortSignal): Promise<string> {
    let current = systemPrompt
    for (const handler of this.handlers.get('before_agent_start') ?? []) {
      try {
        const result = (await handler.value({ type: 'before_agent_start', prompt, systemPrompt: current }, this.context(signal))) as { systemPrompt?: string } | undefined
        if (typeof result?.systemPrompt === 'string') current = result.systemPrompt
      } catch (err) {
        logger.warn('[pi] system extension handler failed', { extension: handler.extension, event: 'before_agent_start', err: (err as Error).message })
      }
    }
    return current
  }

  /** Hooks for `new Agent(...)`; only the ones an extension listens to, so no listener means no change. */
  agentHooks(): ExtensionAgentHooks {
    const hooks: ExtensionAgentHooks = {}
    if (this.has('context')) {
      hooks.transformContext = async (messages, signal) => {
        let current = messages
        for (const handler of this.handlers.get('context')!) {
          const result = (await handler.value({ type: 'context', messages: current }, this.context(signal))) as { messages?: AgentMessage[] } | undefined
          if (result?.messages) current = result.messages
        }
        return current
      }
    }
    if (this.has('before_provider_request')) {
      hooks.onPayload = async (payload) => {
        let current = payload
        for (const handler of this.handlers.get('before_provider_request')!) {
          const result = await handler.value({ type: 'before_provider_request', payload: current }, this.context())
          if (result !== undefined) current = result
        }
        return current
      }
    }
    if (this.has('tool_result')) {
      hooks.afterToolCall = async ({ toolCall, args, result, isError }, signal) => {
        const patched: AfterToolCallResult = { content: result.content, details: result.details, isError }
        let changed = false
        for (const handler of this.handlers.get('tool_result')!) {
          const patch = (await handler.value(
            { type: 'tool_result', toolName: toolCall.name, toolCallId: toolCall.id, input: (args ?? {}) as Record<string, unknown>, content: patched.content, details: patched.details, isError: patched.isError ?? isError },
            this.context(signal),
          )) as AfterToolCallResult | undefined
          if (!patch) continue
          Object.assign(patched, patch)
          changed = true
        }
        return changed ? patched : undefined
      }
    }
    return hooks
  }

  private add(event: EventName, handler: Registered<Handler<any>>): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }
}
