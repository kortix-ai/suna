/**
 * The pi runtime: one pi `Agent` living INSIDE the daemon process.
 *
 * There is no child process, no port and no RPC. pi's tools run against this
 * sandbox's own filesystem and shell, the model goes through the Kortix LLM
 * gateway, and every lifecycle event is reshaped into the OpenCode wire the
 * product already renders (see wire.ts). One pi session IS one Kortix session:
 * the root id is a deterministic function of the session id, so a restart
 * resolves the same root and restores the same transcript from disk.
 *
 * Extensions are pi's own: the Agent runs inside pi-coding-agent's
 * `AgentSession` (extensions/host.ts), so a package from pi.dev loads and runs
 * unmodified. Kortix keeps the model, the tools, the permission gate and the wire.
 *
 * Heavy dependencies (`@earendil-works/pi-*`) load on `start()`, never at
 * import: the resolver imports this module for every boot, including OpenCode's.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool, BeforeToolCallContext, BeforeToolCallResult, ExecutionEnv, Skill } from '@earendil-works/pi-agent-core'
import type { ImageContent, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { HarnessState } from '../lifecycle-contract'
import type { ProjectEnvStore } from '../../project-env'
import { kortixEventBus } from '../../kortix-event-bus'
import { logger } from '../../logger'
import { SECRET_CAPABILITIES_INSTRUCTION_PATH } from '../../secret-capabilities'
import type { PiConfig } from './config'
import { resolvePiSkillDirectories } from './config'
import type { ExtensionStatus, InlineExtension, PiSession, RunnerRef } from './extensions/host'
import type { KortixHost, SpawnSessionInput, SpawnSessionResult } from './extensions/subagents'
import { PermissionBroker, QuestionBroker, compilePermissionPolicy, resolvePolicyRule, type PermissionPolicy, type PermissionRule, type QuestionRequestWire } from './interactions'
import type { CatalogModel, PiModels, SelectedModel } from './model'
import { nativeModelId } from './model'
import { WireTranscript, type WireFrame, type WireMessage } from './transcript'
import { PiWireAdapter, assistantMessageError, type WireEmission } from './wire'
import { WIRE_MESSAGE_ID, WireIdClock, mintChildId, mintRootId } from './wire-id'

export const PI_HARNESS_VERSION = 'pi-agent-core@0.85.1'

/** OpenCode `AgentConfig`, as apps/api compiles it (compile-agent-config.ts). */
export interface CompiledAgent {
  description?: string
  mode?: 'primary' | 'subagent' | 'all'
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  prompt?: string
  disable?: boolean
  hidden?: boolean
  options?: Record<string, unknown>
  color?: string
  steps?: number
  permission?: unknown
}

export interface CompiledAgentConfig {
  model?: string
  agent?: Record<string, CompiledAgent>
}

export function parseCompiledAgentConfig(raw: string | undefined): CompiledAgentConfig | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as CompiledAgentConfig
  } catch {
    logger.warn('[pi] KORTIX_COMPILED_AGENT_CONFIG present but not valid JSON; ignoring')
    return null
  }
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a coding agent working inside a Kortix sandbox. The project repository is checked out at the working directory.',
  'Use the tools to read, search and change files and to run commands. Prefer small, verifiable steps. Report what you did and what remains.',
].join('\n')

export interface PromptInput {
  messageID?: string
  text: string
  files: Array<{ mime: string; url: string; filename?: string }>
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  system?: string
}

export class PromptRejected extends Error {}

/** Validate the OpenCode `prompt_async` body before the runtime acknowledges it. */
export function parsePromptBody(raw: unknown): PromptInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PromptRejected('prompt body must be an object')
  const body = raw as Record<string, unknown>
  if (body.messageID !== undefined) {
    if (typeof body.messageID !== 'string' || !WIRE_MESSAGE_ID.test(body.messageID)) {
      throw new PromptRejected('messageID must use the OpenCode wire format')
    }
  }
  if (body.model !== undefined) {
    const model = body.model as { providerID?: unknown; modelID?: unknown } | null
    if (!model || typeof model !== 'object' || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') {
      throw new PromptRejected('model must contain providerID and modelID strings')
    }
  }
  if (body.agent !== undefined && (typeof body.agent !== 'string' || !body.agent)) throw new PromptRejected('agent must be a non-empty string')
  if (body.variant !== undefined && typeof body.variant !== 'string') throw new PromptRejected('variant must be a string')
  if (body.system !== undefined && typeof body.system !== 'string') throw new PromptRejected('system must be a string')
  if (!Array.isArray(body.parts) || body.parts.length === 0) throw new PromptRejected('parts must be a non-empty array')
  const text: string[] = []
  const files: PromptInput['files'] = []
  for (const rawPart of body.parts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) throw new PromptRejected('prompt parts must be objects')
    const part = rawPart as Record<string, unknown>
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new PromptRejected('text parts require a string text field')
      text.push(part.text)
      continue
    }
    if (part.type === 'file') {
      if (typeof part.url !== 'string' || !part.url) throw new PromptRejected('file parts require a url')
      files.push({
        mime: typeof part.mime === 'string' && part.mime ? part.mime : 'application/octet-stream',
        url: part.url,
        ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
      })
      if (files.length > 16) throw new PromptRejected('at most 16 attachments are supported per prompt')
      continue
    }
    throw new PromptRejected(`prompt part type "${typeof part.type === 'string' ? part.type : 'unknown'}" is not supported`)
  }
  if (text.join('').trim().length === 0 && files.length === 0) throw new PromptRejected('prompt has no content')
  return {
    ...(typeof body.messageID === 'string' ? { messageID: body.messageID } : {}),
    text: text.join(''),
    files,
    ...(typeof body.agent === 'string' ? { agent: body.agent } : {}),
    ...(body.model ? { model: body.model as PromptInput['model'] } : {}),
    ...(typeof body.variant === 'string' ? { variant: body.variant } : {}),
    ...(typeof body.system === 'string' ? { system: body.system } : {}),
  }
}

export type TurnOutcome = 'completed' | 'error' | 'aborted'

export interface TurnEnd {
  messageId: string
  status: 'idle' | 'error'
  error?: { name: string; message?: string }
}

export interface PiRuntimeHooks {
  onTurnBegin?: (turn: { rootId: string; messageId: string }) => void
  onTurnEnd?: (turn: TurnEnd & { rootId: string }) => void
  onQuestionAsked?: (request: QuestionRequestWire, answer: (answers: string[][]) => void) => void
}

export interface PiRuntimeOptions {
  cfg: PiConfig
  sessionId: string
  projectEnv?: ProjectEnvStore
  hooks?: PiRuntimeHooks
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** In-process pi extensions to load; the first-party set (subagents) when absent. */
  extensions?: readonly InlineExtension[]
}

/** A child session a system extension spawned (a subagent). Lives beside the root, never in its transcript. */
interface ChildSession {
  id: string
  title: string
  agentName: string
  createdAt: number
  updatedAt: number
  status: 'idle' | 'busy'
  transcript: WireTranscript
  /** The child's pi conversation, kept so `task_id` resumes it. */
  agentMessages: AgentMessage[]
  /** Set while a prompt runs in the child. */
  agent: Agent | null
}

interface ChildDump {
  id: string
  title: string
  agentName: string
  createdAt: number
  updatedAt: number
  agentMessages: AgentMessage[]
  transcript: WireMessage[]
}

interface Turn {
  messageId: string
  input: PromptInput
  resolve: (outcome: TurnOutcome) => void
  outcome: Promise<TurnOutcome>
}

interface Dump {
  version: 1
  rootId: string
  title: string
  createdAt: number
  agentMessages: AgentMessage[]
  transcript: WireMessage[]
  turns: Array<{ messageId: string; status: 'idle' | 'error' }>
  /** Absent in dumps written before child sessions existed. */
  children?: ChildDump[]
}

function decodeDataUrl(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mime: match[1]!, data: match[2]! } : null
}

export class PiRuntime {
  readonly rootId: string
  readonly transcript = new WireTranscript()
  readonly permissions: PermissionBroker
  readonly questions: QuestionBroker
  readonly createdAt: number
  updatedAt: number
  title: string

  private readonly cfg: PiConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly hooks: PiRuntimeHooks
  private readonly clock = new WireIdClock()
  private state: HarnessState = 'down'
  private startError: string | null = null
  private agent: Agent | null = null
  private models: PiModels | null = null
  private selected: SelectedModel | null = null
  private executionEnv: ExecutionEnv | null = null
  private core: typeof import('@earendil-works/pi-agent-core') | null = null
  /** bash/read/write/edit/glob/grep: what a child session may be given. */
  private workspaceTools: AgentTool<any, any>[] = []
  /** Workspace tools + `question`: the root's tools before extensions add theirs. */
  private baseTools: AgentTool<any, any>[] = []
  private readonly extensionList: readonly InlineExtension[] | undefined
  /** pi's AgentSession around `agent`: extensions, prompt expansion, tool registry. */
  private pi: PiSession | null = null
  /** The current ExtensionRunner; pi swaps it on reload, hooks read it at call time. */
  private readonly runner: RunnerRef = {}
  /** The running turn's `system` addition, applied through `before_agent_start`. */
  private turnSystem: string | null = null
  /** Message conversion + extension provider/context hooks a child agent shares with the root. */
  private childAgentOptions: Partial<AgentOptions> = {}
  private readonly children = new Map<string, ChildSession>()
  private skills: Skill[] = []
  private compiled: CompiledAgentConfig | null = null
  private agentName = 'build'
  private policy: PermissionPolicy = {}
  private adapter: PiWireAdapter | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private active: Turn | null = null
  private runningTools = 0
  private abortAfterTool: { promptId: string; messageId: string } | null = null
  private status: 'idle' | 'busy' = 'idle'
  private readonly completedTurns = new Map<string, 'idle' | 'error'>()
  private workspaceReady = true

  constructor(opts: PiRuntimeOptions) {
    this.cfg = opts.cfg
    this.env = opts.env ?? process.env
    this.now = opts.now ?? (() => Date.now())
    this.hooks = opts.hooks ?? {}
    this.extensionList = opts.extensions
    this.rootId = mintRootId(opts.sessionId)
    this.createdAt = this.now()
    this.updatedAt = this.createdAt
    this.title = 'New session'
    this.permissions = new PermissionBroker(this.rootId, (frame) => this.publish(frame))
    this.questions = new QuestionBroker(this.rootId, (frame) => this.publish(frame), (request) => {
      this.hooks.onQuestionAsked?.(request, (answers) => void this.questions.reply(request.id, answers))
    })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  getState(): HarnessState {
    return this.state
  }

  get lastStartError(): string | null {
    return this.startError
  }

  get workspace(): string {
    return this.cfg.projectTarget || this.cfg.workspace || '/workspace'
  }

  get sessionId(): string {
    return (this.env.KORTIX_SESSION_ID ?? '').trim() || 'session-local'
  }

  markWorkspaceReady(): void {
    this.workspaceReady = true
  }

  async start(): Promise<void> {
    if (this.state === 'ok') return
    this.state = 'starting'
    this.startError = null
    const startedAt = this.now()
    try {
      const [{ createPiModels }, { createWorkspaceTools, createQuestionTool }, core, node, host, { subagents }, { convertToLlm }] = await Promise.all([
        import('./model'),
        import('./tools'),
        import('@earendil-works/pi-agent-core'),
        import('@earendil-works/pi-agent-core/node'),
        import('./extensions/host'),
        import('./extensions/subagents'),
        import('@earendil-works/pi-coding-agent'),
      ])
      this.core = core
      this.compiled = parseCompiledAgentConfig(this.env.KORTIX_COMPILED_AGENT_CONFIG)
      this.agentName = this.resolveAgentName()
      this.models = await createPiModels({
        mode: this.cfg.piModelMode,
        fauxScript: this.cfg.piFauxScript,
        env: this.env,
        defaultModelRef: this.env.KORTIX_OPENCODE_MODEL ?? this.compiledAgent()?.model ?? this.compiled?.model ?? null,
      })
      this.selected = this.models.select(nativeModelId(this.env.KORTIX_OPENCODE_MODEL) ?? nativeModelId(this.compiledAgent()?.model ?? this.compiled?.model))
      this.executionEnv = new node.NodeExecutionEnv({ cwd: this.workspace, shellEnv: this.env })
      this.adapter = new PiWireAdapter({
        sessionID: this.rootId,
        mintMessageId: () => this.clock.mint(this.now()),
        parentMessageId: () => this.active?.messageId ?? null,
        model: () => ({ providerID: this.selected!.providerID, modelID: this.selected!.modelID }),
        agent: this.agentName,
        workspace: this.workspace,
        now: this.now,
        publish: (frame) => this.publish(frame),
      })
      this.workspaceTools = createWorkspaceTools(this.executionEnv)
      // The root agent runs parallel-capable; every built-in tool pins its batch to sequential,
      // so only a batch made entirely of parallel tools (task calls) runs concurrently.
      this.baseTools = [...this.workspaceTools, createQuestionTool(this.questions, (toolCallId) => this.adapter?.toolRef(toolCallId))].map(
        (tool) => ({ ...tool, executionMode: 'sequential' as const }),
      )
      this.skills = await this.loadSkills(core.loadSkills)
      this.policy = compilePermissionPolicy(this.compiledAgent()?.permission)
      this.permissions.setPolicy(this.policy)
      const restored = this.restore()
      const agent = new core.Agent({
        streamFn: (model, context, options) => this.models!.models.streamSimple(model, context, options),
        convertToLlm,
        toolExecution: 'parallel',
        initialState: {
          systemPrompt: '',
          model: this.selected.model,
          thinkingLevel: this.thinkingLevel(this.compiledAgent()?.variant),
          tools: [],
          messages: restored?.agentMessages ?? [],
        },
        ...host.extensionAgentHooks(this.runner),
      })
      this.agent = agent
      this.childAgentOptions = { convertToLlm, ...host.extensionAgentHooks(this.runner) }
      const extensionsStartedAt = performance.now()
      this.pi = await host.createPiSession({
        agent,
        ref: this.runner,
        cwd: this.workspace,
        agentDir: this.cfg.piAgentDir,
        projectPackages: host.parseProjectPackages(this.cfg.piPackages),
        baseTools: this.baseTools,
        extensions: [this.turnExtension(), ...(this.extensionList ?? [subagents(this.kortixHost())])],
        systemPrompt: () => this.systemPrompt(core.formatSkillsForSystemPrompt),
        provider: this.models.models.getProvider(this.selected.providerID),
      })
      const extensionsMs = performance.now() - extensionsStartedAt
      // The session installed the extension tool hooks; the permission policy runs first.
      agent.beforeToolCall = this.toolGate((tool, args) => this.permissions.rule(tool, args), true, agent.beforeToolCall)
      agent.subscribe((event) => this.onAgentEvent(event))
      this.state = 'ok'
      logger.info('[pi] runtime ready', {
        rootId: this.rootId,
        model: `${this.selected.providerID}/${this.selected.modelID}`,
        agent: this.agentName,
        tools: agent.state.tools.map((t) => t.name),
        skills: this.skillList().length,
        extensions: this.pi.status(),
        extensionsMs: Math.round(extensionsMs * 100) / 100,
        restoredMessages: restored?.agentMessages.length ?? 0,
        ms: this.now() - startedAt,
      })
    } catch (err) {
      this.state = 'down'
      this.startError = err instanceof Error ? err.message : String(err)
      logger.error('[pi] runtime start failed', { err: this.startError })
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'down') return
    await this.abort()
    await this.queue.catch(() => {})
    const runner = this.runner.current
    if (runner?.hasHandlers('session_shutdown')) await runner.emit({ type: 'session_shutdown', reason: 'quit' }).catch(() => {})
    this.persist()
    this.pi?.session.dispose()
    this.pi = null
    this.state = 'down'
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /**
   * Re-read the session environment live (`POST /kortix/env`): model, compiled
   * agent config, gateway target. pi has no process to respawn — the next turn
   * runs on the new settings, a running turn finishes on the old ones.
   */
  async reconfigure(): Promise<{ changed: boolean }> {
    if (!this.agent || !this.models) return { changed: false }
    const { createPiModels } = await import('./model')
    const before = `${this.selected?.modelID}|${this.agentName}|${this.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG ?? ''}`
    this.compiled = parseCompiledAgentConfig(this.env.KORTIX_COMPILED_AGENT_CONFIG)
    this.agentName = this.resolveAgentName()
    this.models = await createPiModels({
      mode: this.cfg.piModelMode,
      fauxScript: this.cfg.piFauxScript,
      env: this.env,
      defaultModelRef: this.env.KORTIX_OPENCODE_MODEL ?? this.compiledAgent()?.model ?? this.compiled?.model ?? null,
    })
    this.selected = this.models.select(nativeModelId(this.env.KORTIX_OPENCODE_MODEL) ?? nativeModelId(this.compiledAgent()?.model ?? this.compiled?.model))
    this.policy = compilePermissionPolicy(this.compiledAgent()?.permission)
    this.permissions.setPolicy(this.policy)
    const core = await import('@earendil-works/pi-agent-core')
    this.skills = await this.loadSkills(core.loadSkills)
    // Extensions re-register what depends on the agent config (the task tool lists the subagents).
    await this.runner.current?.emit({ type: 'session_start', reason: 'reload' })
    this.rebuildSystemPrompt()
    this.agent.state.model = this.selected.model
    this.agent.state.thinkingLevel = this.thinkingLevel(this.compiledAgent()?.variant)
    const after = `${this.selected.modelID}|${this.agentName}|${this.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG ?? ''}`
    return { changed: before !== after }
  }

  /** Reload skills from disk (after a repo refresh). */
  async reloadSkills(): Promise<number> {
    if (!this.agent) return 0
    const core = await import('@earendil-works/pi-agent-core')
    this.skills = await this.loadSkills(core.loadSkills)
    this.rebuildSystemPrompt()
    return this.skills.length
  }

  // ── turns ────────────────────────────────────────────────────────────────

  /** True while a turn runs. */
  busy(): boolean {
    return this.status === 'busy'
  }

  activeTurnMessageId(): string | null {
    return this.active?.messageId ?? null
  }

  /**
   * Admit one prompt: publish its user message NOW (the transcript and every
   * subscriber see it before the model is called), then run it on the serial
   * queue. `done` settles with the turn's outcome.
   */
  admit(input: PromptInput): { messageId: string; done: Promise<TurnOutcome> } {
    if (!this.agent || this.state !== 'ok') throw new PromptRejected('pi runtime is not ready')
    if (!this.workspaceReady) throw new PromptRejected('workspace is not ready')
    const messageId = input.messageID ?? this.clock.mint(this.now())
    if (this.transcript.messageById(messageId) || this.completedTurns.has(messageId)) {
      throw new PromptRejected(`message ${messageId} was already admitted`)
    }
    this.clock.observe(messageId)
    if (input.model) {
      const modelId = input.model.providerID === this.selected!.providerID ? input.model.modelID : nativeModelId(`${input.model.providerID}/${input.model.modelID}`)
      if (modelId && modelId !== this.selected!.modelID) this.selected = this.models!.select(modelId)
    }
    this.publishUserMessage(this.rootId, messageId, input)
    let resolve!: (outcome: TurnOutcome) => void
    const outcome = new Promise<TurnOutcome>((r) => (resolve = r))
    const turn: Turn = { messageId, input, resolve, outcome }
    this.queue = this.queue.then(() => this.runTurn(turn)).catch(() => {})
    return { messageId, done: outcome }
  }

  /** Stop the run in flight. Idempotent: aborting an idle agent is a no-op. */
  async abort(): Promise<boolean> {
    if (!this.active) return false
    this.permissions.rejectAll()
    this.questions.rejectAll()
    this.agent?.abort()
    await this.active.outcome
    return true
  }

  /**
   * Quick Queue: end the named turn once no tool is running. A tool in flight
   * is never killed; the model's own streaming may be cut.
   */
  armAbortAfterTool(input: { promptId: string; opencodeSessionId: string; messageId: string }): void {
    if (input.opencodeSessionId !== this.rootId) return
    this.abortAfterTool = { promptId: input.promptId, messageId: input.messageId }
    this.checkAbortAfterTool()
  }

  /** Without a prompt id, disarm whatever is pending. */
  disarmAbortAfterTool(promptId?: string): void {
    if (promptId && this.abortAfterTool?.promptId !== promptId) return
    this.abortAfterTool = null
  }

  private checkAbortAfterTool(): void {
    const armed = this.abortAfterTool
    if (!armed) return
    // Idle, or another turn is running: a late arm must not stop its successor.
    if (this.active?.messageId !== armed.messageId) {
      this.abortAfterTool = null
      return
    }
    if (this.runningTools > 0) return
    this.abortAfterTool = null
    void this.abort()
  }

  private async runTurn(turn: Turn): Promise<void> {
    const agent = this.agent!
    this.active = turn
    this.status = 'busy'
    this.hooks.onTurnBegin?.({ rootId: this.rootId, messageId: turn.messageId })
    let outcome: TurnOutcome = 'completed'
    let error: TurnEnd['error'] | undefined
    const before = agent.state.messages.length
    try {
      agent.state.model = this.selected!.model
      agent.state.thinkingLevel = this.thinkingLevel(turn.input.variant ?? this.compiledAgent()?.variant)
      this.turnSystem = turn.input.system ?? null
      // pi's prompt path: `input` and `before_agent_start` handlers, extension commands, `/skill:` and templates.
      const images = this.images(turn.input)
      await this.pi!.session.prompt(turn.input.text || '(attachment)', { source: 'rpc', ...(images.length ? { images } : {}) })
      // Only this turn's messages: an extension command answers without a model call.
      const last = agent.state.messages.slice(before).reverse().find((m) => m.role === 'assistant') as
        | { stopReason?: string; errorMessage?: string }
        | undefined
      if (last?.stopReason === 'aborted') outcome = 'aborted'
      else if (last && (last.stopReason === 'error' || last.stopReason === 'length')) {
        outcome = 'error'
        const wire = assistantMessageError({ stopReason: last.stopReason as never, errorMessage: last.errorMessage })
        error = wire ? { name: wire.name, message: (wire.data as { message?: string }).message } : undefined
      }
    } catch (err) {
      outcome = 'error'
      const message = err instanceof Error ? err.message : String(err)
      error = { name: 'UnknownError', message }
      logger.error('[pi] turn failed', { messageId: turn.messageId, err: message })
      this.publish({ type: 'session.error', properties: { sessionID: this.rootId, error: { name: 'UnknownError', data: { message } } } })
      this.publish({ type: 'session.status', properties: { sessionID: this.rootId, status: { type: 'idle' } } })
      this.publish({ type: 'session.idle', properties: { sessionID: this.rootId } })
    } finally {
      this.turnSystem = null
      this.permissions.rejectAll()
      this.questions.rejectAll()
      this.active = null
      this.runningTools = 0
      this.abortAfterTool = null
      this.status = 'idle'
      this.completedTurns.set(turn.messageId, outcome === 'error' ? 'error' : 'idle')
      this.persist()
      turn.resolve(outcome)
      this.hooks.onTurnEnd?.({ rootId: this.rootId, messageId: turn.messageId, status: outcome === 'error' ? 'error' : 'idle', ...(error ? { error } : {}) })
    }
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === 'tool_execution_start') this.runningTools += 1
    if (event.type === 'tool_execution_end') this.runningTools = Math.max(0, this.runningTools - 1)
    this.translateAndPublish(event)
    // After the frames: the finished tool part is on the transcript before the turn is cut.
    if (event.type === 'tool_execution_end') this.checkAbortAfterTool()
  }

  /** Permission policy first, then extension `tool_call` handlers (`next`). Root and child agents share it. */
  private toolGate(rule: (tool: string, args: unknown) => PermissionRule, attachToPart: boolean, next: Agent['beforeToolCall']) {
    return async (context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
      const tool = context.toolCall.name
      const decided = rule(tool, context.args)
      if (decided === 'deny') return { block: true, reason: `The project policy denies this ${tool} call.` }
      if (decided === 'ask') {
        const reply = await this.permissions.ask({
          tool,
          args: context.args,
          ...(attachToPart ? { ref: this.adapter?.toolRef(context.toolCall.id, { name: tool, args: context.args }) } : {}),
        })
        if (reply === 'reject') return { block: true, reason: 'The user rejected this tool call.' }
      }
      return next?.(context, signal)
    }
  }

  /** Extension `tool_call` handlers for a child agent, which has no AgentSession of its own. */
  private childExtensionGate(): Agent['beforeToolCall'] {
    return async (context) => {
      const runner = this.runner.current
      if (!runner?.hasHandlers('tool_call')) return undefined
      return runner.emitToolCall({ type: 'tool_call', toolName: context.toolCall.name, toolCallId: context.toolCall.id, input: (context.args ?? {}) as Record<string, unknown> })
    }
  }

  /** Extension `tool_result` handlers for a child agent. */
  private childToolResult(): Agent['afterToolCall'] {
    return async ({ toolCall, args, result, isError }) => {
      const runner = this.runner.current
      if (!runner?.hasHandlers('tool_result')) return undefined
      const patched = await runner.emitToolResult({
        type: 'tool_result',
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: (args ?? {}) as Record<string, unknown>,
        content: result.content,
        details: result.details,
        isError,
      } as never)
      return patched ? { content: patched.content ?? result.content, details: patched.details, isError: patched.isError ?? isError } : undefined
    }
  }

  /** Adds the running turn's `system` text on top of whatever the prompt is by then. */
  private turnExtension(): InlineExtension {
    return {
      name: 'kortix-turn',
      hidden: true,
      factory: (pi) => {
        pi.on('before_agent_start', (event) => (this.turnSystem ? { systemPrompt: `${event.systemPrompt}\n\n${this.turnSystem}` } : undefined))
      },
    }
  }

  /** Re-read the base system prompt (compiled agent, skills) into pi's session. */
  private rebuildSystemPrompt(): void {
    const session = this.pi?.session
    if (session) session.setActiveToolsByName(session.getActiveToolNames())
  }

  // ── child sessions ───────────────────────────────────────────────────────

  private kortixHost(): KortixHost {
    return {
      compiledAgents: () => this.compiled?.agent ?? {},
      spawnSession: (input) => this.spawnSession(input),
    }
  }

  /**
   * Run one prompt in a child session: its own pi agent, wire adapter and
   * transcript, on the same models, workspace and extension hooks. Frames go
   * on the bus under the child's id, so the product streams the child exactly
   * as it streams an OpenCode subagent. The caller's signal aborts the child.
   */
  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    const core = this.core
    if (!core || !this.models || !this.selected || this.state !== 'ok') throw new Error('pi runtime is not ready')
    let child = input.sessionId ? this.children.get(input.sessionId) : undefined
    if (input.sessionId && !child) throw new Error(`task_id ${input.sessionId} is not a subagent session of this session`)
    if (child?.agent) throw new Error(`task_id ${child.id} is already running`)
    if (!child) {
      const createdAt = this.now()
      child = {
        id: mintChildId(this.rootId, this.clock.mint(createdAt)),
        title: input.title,
        agentName: input.agent,
        createdAt,
        updatedAt: createdAt,
        status: 'idle',
        transcript: new WireTranscript(),
        agentMessages: [],
        agent: null,
      }
      this.children.set(child.id, child)
      this.publish({ type: 'session.created', properties: { sessionID: child.id, info: this.childSessionObject(child) } })
    }
    const selected = input.model ? this.models.select(nativeModelId(input.model)) : this.selected
    const model = { providerID: selected.providerID, modelID: selected.modelID }
    const tools = input.tools ? this.workspaceTools.filter((tool) => input.tools!.includes(tool.name)) : this.workspaceTools
    const policy = compilePermissionPolicy(input.permission)
    const messageId = this.clock.mint(this.now())
    this.publishUserMessage(child.id, messageId, { messageID: messageId, text: input.prompt, files: [] }, { agent: input.agent, selected })
    const adapter = new PiWireAdapter({
      sessionID: child.id,
      mintMessageId: () => this.clock.mint(this.now()),
      parentMessageId: () => messageId,
      model: () => model,
      agent: input.agent,
      workspace: this.workspace,
      now: this.now,
      publish: (frame) => this.publish(frame),
    })
    const agent = new core.Agent({
      streamFn: (m, context, options) => this.models!.models.streamSimple(m, context, options),
      toolExecution: 'sequential',
      initialState: {
        systemPrompt: this.systemPrompt(core.formatSkillsForSystemPrompt, { base: input.systemPrompt, tools, interactive: false }),
        model: selected.model,
        thinkingLevel: this.thinkingLevel(input.variant, selected),
        tools,
        messages: child.agentMessages,
      },
      ...this.childAgentOptions,
    })
    agent.afterToolCall = this.childToolResult()
    // The subagent's own rules first, the session's rules otherwise. A deny from
    // either wins: delegating must never unlock a call the session denies.
    agent.beforeToolCall = this.toolGate((tool, args) => {
      const own = resolvePolicyRule(policy, tool, args)
      const session = this.permissions.rule(tool, args)
      if (own === 'deny' || session === 'deny') return 'deny'
      return own ?? session
    }, false, this.childExtensionGate())
    agent.subscribe((event) => {
      for (const frame of adapter.translate(event)) this.publish(frame, frame.transcriptOnly ? { transcriptOnly: true } : undefined)
    })
    child.agent = agent
    input.onSession?.({ sessionId: child.id, model })
    const abort = () => agent.abort()
    input.signal?.addEventListener('abort', abort, { once: true })
    let status: SpawnSessionResult['status'] = 'completed'
    let error: string | undefined
    let text = ''
    try {
      if (input.signal?.aborted) status = 'aborted'
      else {
        await agent.prompt({ role: 'user', content: input.prompt, timestamp: this.now() })
        const last = [...agent.state.messages].reverse().find((m) => m.role === 'assistant') as
          | { stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }
          | undefined
        text = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
        if (last?.stopReason === 'aborted') status = 'aborted'
        else if (last?.stopReason === 'error' || last?.stopReason === 'length') {
          status = 'error'
          error = last.errorMessage || (last.stopReason === 'length' ? 'The subagent hit the output length limit.' : 'The model request failed.')
        }
      }
    } catch (err) {
      status = 'error'
      error = err instanceof Error ? err.message : String(err)
      logger.error('[pi] child session failed', { sessionId: child.id, err: error })
    } finally {
      input.signal?.removeEventListener('abort', abort)
      child.agentMessages = agent.state.messages
      child.agent = null
      if (child.status === 'busy') {
        this.publish({ type: 'session.status', properties: { sessionID: child.id, status: { type: 'idle' } } })
        this.publish({ type: 'session.idle', properties: { sessionID: child.id } })
      }
    }
    return { sessionId: child.id, status, text, ...(error ? { error } : {}), model }
  }

  /** The child session a read names, or null. */
  childSession(id: string): { object: Record<string, unknown>; transcript: WireTranscript } | null {
    const child = this.children.get(id)
    return child ? { object: this.childSessionObject(child), transcript: child.transcript } : null
  }

  childSessions(): Array<Record<string, unknown>> {
    return [...this.children.values()].map((child) => this.childSessionObject(child))
  }

  private childSessionObject(child: ChildSession): Record<string, unknown> {
    return { ...this.sessionObject(), id: child.id, slug: child.id, parentID: this.rootId, title: child.title, time: { created: child.createdAt, updated: child.updatedAt } }
  }

  extensionStatus(): ExtensionStatus {
    return this.pi?.status() ?? { loaded: [], failed: [] }
  }

  private translateAndPublish(event: AgentEvent): void {
    if (!this.adapter) return
    let frames: WireEmission[]
    try {
      frames = this.adapter.translate(event)
    } catch (err) {
      logger.warn('[pi] wire translation failed', { type: event.type, err: (err as Error).message })
      return
    }
    for (const frame of frames) this.publish(frame, frame.transcriptOnly ? { transcriptOnly: true } : undefined)
  }

  /** Sequence one wire frame onto the bus AND fold it into the transcript. */
  publish(frame: WireFrame, opts: { transcriptOnly?: boolean; busOnly?: boolean } = {}): void {
    const p = frame.properties
    const session =
      (p.sessionID as string | undefined) ??
      (p.info as { sessionID?: string } | undefined)?.sessionID ??
      (p.part as { sessionID?: string } | undefined)?.sessionID
    const status = frame.type === 'session.status' ? (p.status as { type?: string } | undefined)?.type : undefined
    const child = session && session !== this.rootId ? this.children.get(session) : undefined
    if (child) {
      child.updatedAt = this.now()
      if (status === 'busy' || status === 'idle') child.status = status
      if (!opts.busOnly) child.transcript.apply(frame)
    } else {
      this.updatedAt = this.now()
      if (status === 'busy' || status === 'idle') this.status = status
      if (!opts.busOnly) this.transcript.apply(frame)
    }
    if (opts.transcriptOnly) return
    kortixEventBus().publish(frame.type, p, session)
  }

  private publishUserMessage(
    sessionID: string,
    messageId: string,
    input: PromptInput,
    as: { agent: string; selected: SelectedModel } = { agent: this.agentName, selected: this.selected! },
  ): void {
    const created = this.now()
    if (sessionID === this.rootId && this.title === 'New session') {
      const line = input.text.trim().split('\n')[0] ?? ''
      if (line) this.title = line.length > 80 ? `${line.slice(0, 77)}…` : line
    }
    this.publish({
      type: 'message.updated',
      properties: {
        sessionID,
        info: {
          id: messageId,
          role: 'user',
          sessionID,
          time: { created },
          agent: as.agent,
          model: { providerID: as.selected.providerID, modelID: as.selected.modelID, ...(input.variant ? { variant: input.variant } : {}) },
        },
      },
    })
    let index = 0
    if (input.text) {
      this.publish({
        type: 'message.part.updated',
        properties: {
          sessionID,
          time: created,
          part: { id: `${messageId}-p${index++}`, messageID: messageId, sessionID, type: 'text', text: input.text },
        },
      })
    }
    for (const file of input.files) {
      this.publish({
        type: 'message.part.updated',
        properties: {
          sessionID,
          time: created,
          part: {
            id: `${messageId}-p${index++}`,
            messageID: messageId,
            sessionID,
            type: 'file',
            mime: file.mime,
            url: file.url,
            ...(file.filename ? { filename: file.filename } : {}),
          },
        },
      })
    }
  }

  /** The prompt's image attachments, when the selected model reads images. */
  private images(input: PromptInput): ImageContent[] {
    const images: ImageContent[] = []
    if (!this.selected?.images) return images
    for (const file of input.files) {
      if (!file.mime.startsWith('image/')) continue
      const decoded = decodeDataUrl(file.url)
      if (decoded) images.push({ type: 'image', data: decoded.data, mimeType: decoded.mime })
    }
    return images
  }

  // ── configuration ────────────────────────────────────────────────────────

  private resolveAgentName(): string {
    const requested = (this.env.KORTIX_AGENT_NAME ?? '').trim()
    const agents = Object.keys(this.compiled?.agent ?? {})
    if (requested && requested !== 'default' && (agents.length === 0 || agents.includes(requested))) return requested
    return agents[0] ?? 'build'
  }

  private compiledAgent(): CompiledAgent | undefined {
    return this.compiled?.agent?.[this.agentName]
  }

  private thinkingLevel(variant: string | undefined, selected: SelectedModel | null = this.selected): ModelThinkingLevel {
    if (!selected || !variant) return 'off'
    return selected.variants.includes(variant) ? (variant as ModelThinkingLevel) : 'off'
  }

  private async loadSkills(load: typeof import('@earendil-works/pi-agent-core').loadSkills): Promise<Skill[]> {
    if (!this.executionEnv) return []
    const dirs = resolvePiSkillDirectories(this.cfg).filter((dir) => existsSync(dir))
    if (dirs.length === 0) return []
    try {
      const { BACKGROUND_CONTEXT } = await import('@earendil-works/pi-agent-core/harness/context')
      const { skills, diagnostics } = await load(this.executionEnv, dirs, BACKGROUND_CONTEXT)
      for (const diagnostic of diagnostics) logger.warn('[pi] skill diagnostic', diagnostic)
      // Two directories can carry the same skill (a project's OpenCode copy and
      // the managed overlay): the first directory wins, like OpenCode's search order.
      const seen = new Set<string>()
      return skills.filter((skill) => (seen.has(skill.name) ? false : (seen.add(skill.name), true)))
    } catch (err) {
      logger.warn('[pi] skill load failed', { err: (err as Error).message })
      return []
    }
  }

  /** The root's system prompt; a child passes its own base prompt and tools, and cannot ask questions. */
  private systemPrompt(
    formatSkills: (skills: Skill[]) => string,
    child?: { base: string; tools: AgentTool<any, any>[]; interactive: false },
  ): string {
    const parts = [child?.base || this.compiledAgent()?.prompt?.trim() || DEFAULT_SYSTEM_PROMPT]
    // pi appends the working directory (and package skills) to the root's prompt.
    if (child) parts.push(`Working directory: ${this.workspace}`)
    if (this.skills.length > 0) parts.push(formatSkills(this.skills))
    const capabilities = this.readInstruction(SECRET_CAPABILITIES_INSTRUCTION_PATH)
    if (capabilities) parts.push(capabilities)
    parts.push(
      [
        '## Runtime capabilities',
        `Registered tools: ${(child?.tools ?? this.agent?.state.tools ?? this.baseTools).map((t) => t.name).join(', ')}.`,
        'Call tools normally; the runtime asks the user for permission when the project policy requires it.',
        ...(child ? [] : ['Use question to collect answers through the interactive question UI.']),
      ].join('\n'),
    )
    return parts.join('\n\n')
  }

  private readInstruction(path: string): string | null {
    try {
      const text = readFileSync(path, 'utf8').trim()
      return text || null
    } catch {
      return null
    }
  }

  // ── projections ──────────────────────────────────────────────────────────

  selectedModel(): SelectedModel | null {
    return this.selected
  }

  agentNameValue(): string {
    return this.agentName
  }

  /** Kortix skills first, then skills pi loaded from packages; a name appears once. */
  skillList(): Array<Pick<Skill, 'name' | 'description' | 'filePath'>> {
    const seen = new Set(this.skills.map((skill) => skill.name))
    return [...this.skills, ...(this.pi?.skills() ?? []).filter((skill) => !seen.has(skill.name) && (seen.add(skill.name), true))]
  }

  toolList(): Array<{ id: string; description: string; parameters: unknown }> {
    return (this.agent?.state.tools ?? []).map((tool) => ({ id: tool.name, description: tool.description, parameters: tool.parameters }))
  }

  sessionStatus(): { type: 'idle' | 'busy' } {
    return { type: this.status }
  }

  /** The OpenCode `Session` object for this root. */
  sessionObject(): Record<string, unknown> {
    return {
      id: this.rootId,
      slug: this.rootId,
      projectID: (this.env.KORTIX_PROJECT_ID ?? '').trim() || this.sessionId,
      directory: this.workspace,
      title: this.title,
      version: PI_HARNESS_VERSION,
      time: { created: this.createdAt, updated: this.updatedAt },
    }
  }

  /** The OpenCode `Agent` object for the selected agent. */
  agentObject(): Record<string, unknown> {
    const agent = this.compiledAgent() ?? {}
    return {
      name: this.agentName,
      ...(agent.description !== undefined ? { description: agent.description } : {}),
      mode: agent.mode ?? 'primary',
      native: false,
      hidden: agent.hidden === true || agent.disable === true,
      ...(agent.top_p !== undefined ? { topP: agent.top_p } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.color !== undefined ? { color: agent.color } : {}),
      permission: this.policy,
      ...(this.selected ? { model: { providerID: this.selected.providerID, modelID: this.selected.modelID } } : {}),
      ...(agent.variant !== undefined ? { variant: agent.variant } : {}),
      ...(agent.prompt !== undefined ? { prompt: agent.prompt } : {}),
      options: { ...(agent.options ?? {}) },
      ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
    }
  }

  /** The OpenCode `Config` document the picker and composer read. */
  configObject(): Record<string, unknown> {
    const selected = this.selected
    const provider =
      selected && (selected.variants.length > 0 || selected.images)
        ? {
            provider: {
              [selected.providerID]: {
                models: {
                  [selected.modelID]: {
                    ...(selected.variants.length ? { variants: Object.fromEntries(selected.variants.map((v) => [v, {}])) } : {}),
                    attachment: selected.images,
                  },
                },
              },
            },
          }
        : {}
    return {
      ...provider,
      default_agent: this.agentName,
      ...(selected ? { model: `${selected.providerID}/${selected.modelID}` } : {}),
      agent: this.compiled?.agent ?? {},
      permission: this.compiledAgent()?.permission ?? {},
      autoupdate: false,
    }
  }

  /** The OpenCode `/provider` document: one gateway provider, the catalog as its models. */
  providerList(): Record<string, unknown> {
    const selected = this.selected
    const catalog = this.models?.catalog ?? {}
    const providerID = selected?.providerID ?? 'kortix'
    const models: Record<string, unknown> = {}
    const entries: Array<[string, CatalogModel]> =
      Object.keys(catalog).length > 0 ? Object.entries(catalog) : selected ? [[selected.modelID, { name: selected.modelID }]] : []
    for (const [id, entry] of entries) {
      models[id] = {
        id,
        providerID,
        name: entry.name ?? id,
        api: { id: 'openai-completions', url: '', npm: '@earendil-works/pi-ai' },
        capabilities: {
          temperature: true,
          reasoning: entry.reasoning === true,
          attachment: entry.attachment === true,
          toolcall: true,
          input: { text: true, audio: false, image: entry.attachment === true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: entry.limit?.context ?? 128_000, output: entry.limit?.output ?? 32_768 },
        status: 'active',
        options: {},
        headers: {},
        release_date: '',
        variants: Object.fromEntries(Object.keys(entry.variants ?? {}).map((v) => [v, {}])),
      }
    }
    const provider = { id: providerID, name: providerID === 'faux' ? 'Faux' : 'Kortix', source: 'config', env: [], options: {}, models }
    return {
      all: [provider],
      default: selected ? { [providerID]: selected.modelID } : {},
      connected: [providerID],
    }
  }

  /** The `/kortix/opencode/state` document. */
  stateDoc(): Record<string, unknown> {
    const bus = kortixEventBus()
    const selected = this.selected
    const agents = Object.entries(this.compiled?.agent ?? { [this.agentName]: this.compiledAgent() ?? {} }).map(([name, agent]) => ({
      name,
      description: agent?.description ?? null,
      mode: agent?.mode ?? null,
      native: false,
      hidden: agent?.hidden ?? null,
      color: agent?.color ?? null,
      variant: agent?.variant ?? null,
      source: 'config',
      model:
        name === this.agentName && selected
          ? { providerID: selected.providerID, modelID: selected.modelID }
          : agent?.model && nativeModelId(agent.model)
            ? { providerID: 'kortix', modelID: nativeModelId(agent.model)! }
            : null,
    }))
    return {
      epoch: bus.epoch,
      seq: bus.headSeq,
      built_at: new Date(this.now()).toISOString(),
      identity: {
        opencode_session_id: this.rootId,
        opencode_version: PI_HARNESS_VERSION,
        daemon_build: null,
        agent_config_etag: this.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
        head_seq: null,
        harness: 'pi',
      },
      agents: { known: true, value: agents },
      commands: { known: true, value: [] },
      config: {
        known: true,
        value: {
          model: selected ? `${selected.providerID}/${selected.modelID}` : null,
          small_model: null,
          default_agent: this.agentName,
          permission: this.compiledAgent()?.permission ?? null,
          instructions: null,
          enabled_providers: selected ? [selected.providerID] : null,
        },
      },
      sessions: {
        known: true,
        value: [
          {
            id: this.rootId,
            title: this.title,
            parent_id: null,
            directory: this.workspace,
            time: { created: this.createdAt, updated: this.updatedAt, compacting: null },
            revert: null,
          },
          ...[...this.children.values()].map((child) => ({
            id: child.id,
            title: child.title,
            parent_id: this.rootId,
            directory: this.workspace,
            time: { created: child.createdAt, updated: child.updatedAt, compacting: null },
            revert: null,
          })),
        ],
      },
      statuses: {
        known: true,
        value: Object.fromEntries([[this.rootId, this.sessionStatus()], ...[...this.children.values()].map((child) => [child.id, { type: child.status }])]),
      },
      permissions: { known: true, value: this.permissions.list() },
      questions: { known: true, value: this.questions.list() },
    }
  }

  stateEtag(doc: Record<string, unknown>): string {
    const { built_at: _built, ...rest } = doc
    return `"sha256-${createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 32)}"`
  }

  /**
   * The turn probe behind `/kortix/health?turn=1` and `/kortix/opencode/turn/:id`.
   * The reaper renews a box's deadline on `inFlight`, records `end` when a
   * turn is over, and redelivers a prompt reported `abandoned`.
   */
  turnProbe(messageId: string | null): { inFlight: boolean; end: 'completed' | 'failed' | 'abandoned' | null; orphanedPrompt: boolean } {
    if (messageId === null) {
      return { inFlight: this.busy(), end: this.busy() ? null : this.latestEnd(), orphanedPrompt: false }
    }
    if (this.active?.messageId === messageId) return { inFlight: true, end: null, orphanedPrompt: false }
    const completed = this.completedTurns.get(messageId)
    if (completed) return { inFlight: false, end: completed === 'error' ? 'failed' : 'completed', orphanedPrompt: false }
    // Queued behind the running turn: on record, not yet answered, still ours.
    if (this.transcript.messageById(messageId)) return { inFlight: true, end: null, orphanedPrompt: false }
    return { inFlight: false, end: 'abandoned', orphanedPrompt: true }
  }

  private latestEnd(): 'completed' | 'failed' | null {
    const last = [...this.completedTurns.values()].at(-1)
    return last ? (last === 'error' ? 'failed' : 'completed') : null
  }

  // ── durability ───────────────────────────────────────────────────────────

  private dumpPath(): string {
    return join(this.cfg.piStateDir, `${this.sessionId}.json`)
  }

  private persist(): void {
    if (!this.agent) return
    try {
      mkdirSync(this.cfg.piStateDir, { recursive: true, mode: 0o700 })
      const dump: Dump = {
        version: 1,
        rootId: this.rootId,
        title: this.title,
        createdAt: this.createdAt,
        agentMessages: this.agent.state.messages,
        transcript: this.transcript.all(),
        turns: [...this.completedTurns.entries()].map(([messageId, status]) => ({ messageId, status })),
        children: [...this.children.values()].map((child) => ({
          id: child.id,
          title: child.title,
          agentName: child.agentName,
          createdAt: child.createdAt,
          updatedAt: child.updatedAt,
          agentMessages: child.agent ? child.agent.state.messages : child.agentMessages,
          transcript: child.transcript.all(),
        })),
      }
      const tmp = `${this.dumpPath()}.tmp`
      // CodeQL js/http-to-file-access (alert 6571) flags the CONTENT argument
      // below, because `dump.transcript` carries the first-turn prompt that
      // relay.ts fetched from the Kortix API. Only the content is network-derived;
      // the PATH is not. `dumpPath()` is built from `cfg.piStateDir`
      // (KORTIX_PI_STATE_DIR, else <runtime-state-dir>/pi) and `sessionId`
      // (KORTIX_SESSION_ID) — both process env, and the /kortix/env route cannot
      // set either one (project-env.ts skips every KORTIX_-prefixed key, and the
      // control.ts allowlist does not contain them). So no response can redirect
      // this write. `JSON.stringify` escapes the content into one JSON document,
      // `restore()` reads it back with `JSON.parse` behind a version + rootId
      // check, and the result is consumed as transcript data — never executed,
      // and never a config the agent trusts. The dir is 0o700, the file 0o600,
      // and piStateDir lives outside /workspace, so it is not in the project
      // repo or snapshot. Keep the path env-derived; do not take it from a
      // request or a response body.
      writeFileSync(tmp, JSON.stringify(dump), { mode: 0o600 })
      renameSync(tmp, this.dumpPath())
    } catch (err) {
      logger.warn('[pi] transcript persist failed', { err: (err as Error).message })
    }
  }

  private restore(): Dump | null {
    try {
      if (!existsSync(this.dumpPath())) return null
      const dump = JSON.parse(readFileSync(this.dumpPath(), 'utf8')) as Dump
      if (dump.version !== 1 || dump.rootId !== this.rootId) return null
      this.transcript.load(dump.transcript)
      for (const message of dump.transcript) this.clock.observe(message.info.id as string)
      for (const turn of dump.turns) this.completedTurns.set(turn.messageId, turn.status)
      this.children.clear()
      for (const saved of dump.children ?? []) {
        const transcript = new WireTranscript()
        transcript.load(saved.transcript)
        for (const message of saved.transcript) this.clock.observe(message.info.id as string)
        const { transcript: _saved, ...rest } = saved
        this.children.set(saved.id, { ...rest, transcript, status: 'idle', agent: null })
      }
      this.title = dump.title
      return dump
    } catch (err) {
      logger.warn('[pi] transcript restore failed; starting empty', { err: (err as Error).message })
      return null
    }
  }
}
