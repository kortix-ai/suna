/**
 * The pi runtime: one pi `Agent` living INSIDE the daemon process.
 *
 * There is no child process, no port and no RPC. pi's tools run against this
 * sandbox's own filesystem and shell, the model goes through the Kortix LLM
 * gateway, and every lifecycle event is emitted as a Kortix session event
 * (`kortix.transcript.v1`, see turn-events.ts). One pi session IS one Kortix session:
 * the root id is a deterministic function of the session id, so a restart
 * resolves the same root and restores the same transcript from disk.
 *
 * Extensions are pi's own: the Agent runs inside pi-coding-agent's
 * `AgentSession` (extensions/host.ts), so a package from pi.dev loads and runs
 * unmodified. Kortix keeps the model, the tools, the permission gate and the event format.
 *
 * Heavy dependencies (`@earendil-works/pi-*`) load on `start()`, never at
 * import: the resolver imports this module for every boot, including OpenCode's.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { ImageContent, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, SessionEntry, Skill } from '@earendil-works/pi-coding-agent'
import { KORTIX_RUNTIME_SCHEMA, type CompiledAgent, type CompiledAgentSet } from '@kortix/api-contract/runtime-relay'
import type { KortixAssistantMessageInfo, KortixMessage, KortixMessageError, RuntimePermissionRequest, RuntimeQuestionRequest, TurnErrorCode } from '@kortix/api-contract/transcript'
import type { HarnessState } from '../contract/lifecycle-contract'
import { kortixEventBus } from '@/services/event-bus/kortix-event-bus'
import { logger } from '@/lib/log/logger'
import { SECRET_CAPABILITIES_INSTRUCTION_PATH } from '@/services/sandbox-env/secret-capabilities'
import type { PiConfig } from './config'
import { resolvePiProjectConfigDir, resolvePiSkillDirectories } from './config'
import type { PiConfigReleases } from './config-release'
import type { ExtensionStatus, InlineExtension, PiSession, RunnerRef } from './extensions/host'
import type { KortixHost, SpawnSessionInput, SpawnSessionResult } from './extensions/subagents'
import { PermissionBroker, QuestionBroker, compilePermissionPolicy, resolvePolicyRule, skillGranted, type PermissionPolicy, type PermissionRule } from './interactions'
import type { PiModels, SelectedModel } from './model'
import { nativeModelId } from './model'
import { TranscriptStore, type RuntimeFrame } from './transcript'
import { PiTurnEvents, assistantInfoFields, assistantMessageError, type TurnEventEmission } from './turn-events'
import { withAgentSampling } from './sampling'
import { TransientRetry, type RetryPlan } from './transient-retry'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { MESSAGE_ID, MessageIdClock, mintChildId, mintRootId } from './message-id'

import { PI_HARNESS_VERSION } from './version'

export type { CompiledAgent }

/** The compiled agent set as `KORTIX_COMPILED_AGENT_CONFIG` carries it (apps/api compile-agent-config.ts). */
export type CompiledAgentConfig = Partial<CompiledAgentSet>

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
  /** OpenCode `noReply`: the message joins the conversation, no turn runs. */
  noReply?: boolean
  /** A slash command (`/name arguments`): the user message on the wire becomes the text pi expands it to. */
  command?: boolean
}

export class PromptRejected extends Error {}

/** OpenCode's `retry` session status from a retry plan (the wire's `retryPlan`). */
const retryStatus = (plan: RetryPlan | null | undefined) => (plan ? { attempt: plan.attempt, message: plan.message, next: plan.next } : null)

/** Validate the OpenCode `prompt_async` body before the runtime acknowledges it. */
export function parsePromptBody(raw: unknown): PromptInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PromptRejected('prompt body must be an object')
  const body = raw as Record<string, unknown>
  if (body.messageID !== undefined) {
    if (typeof body.messageID !== 'string' || !MESSAGE_ID.test(body.messageID)) {
      throw new PromptRejected('messageID must be a Kortix message id (msg_ + 12 hex clock + 14 base62)')
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
  if (body.noReply !== undefined && typeof body.noReply !== 'boolean') throw new PromptRejected('noReply must be a boolean')
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
    ...(body.noReply === true ? { noReply: true } : {}),
  }
}

export type TurnOutcome = 'completed' | 'error' | 'aborted'

export interface TurnEnd {
  messageId: string
  status: 'idle' | 'error'
  error?: { name: string; message?: string; statusCode?: number; code?: TurnErrorCode }
}

export interface PiRuntimeHooks {
  onTurnBegin?: (turn: { rootId: string; messageId: string }) => void
  onTurnEnd?: (turn: TurnEnd & { rootId: string }) => void
  onQuestionAsked?: (request: RuntimeQuestionRequest, answer: (answers: string[][]) => void) => void
  /** A tool call waits for the user's approval (root or subagent). Report only: the reply comes over the permission routes. */
  onPermissionAsked?: (request: RuntimePermissionRequest) => void
  /** Every frame the runtime publishes on the event bus (the audit trail reads it). */
  onFrame?: (frame: RuntimeFrame) => void
}

export interface PiRuntimeOptions {
  cfg: PiConfig
  sessionId: string
  hooks?: PiRuntimeHooks
  env?: NodeJS.ProcessEnv
  /** The config release the runtime reads skills and the session notice from (config-release.ts). */
  releases?: Pick<PiConfigReleases, 'skillDirs' | 'piConfigDir' | 'notice'>
}

/** A child session a system extension spawned (a subagent). Lives beside the root, never in its transcript. */
interface ChildSession {
  id: string
  title: string
  agentName: string
  createdAt: number
  updatedAt: number
  status: 'idle' | 'busy'
  transcript: TranscriptStore
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
  transcript: KortixMessage[]
}

interface Turn {
  messageId: string
  input: PromptInput
  resolve: (outcome: TurnOutcome) => void
  outcome: Promise<TurnOutcome>
  /**
   * Stop or the watchdog asked to end the turn. pi may still be compacting
   * before the model call, where `agent.abort()` has no run to stop: the
   * run that starts afterwards is cut at `agent_start`.
   */
  stopRequested?: boolean
}

interface Dump {
  version: 1
  rootId: string
  title: string
  createdAt: number
  /** The model context. A daemon built before pi 1.0 restores from it; this one reads `entries`. Remove when no such daemon runs. */
  agentMessages: AgentMessage[]
  /** pi's session entries: the conversation, its context edits and its compactions. Absent in a dump written before pi 1.0. */
  entries?: SessionEntry[]
  transcript: KortixMessage[]
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
  readonly transcript = new TranscriptStore()
  readonly permissions: PermissionBroker
  readonly questions: QuestionBroker
  readonly createdAt: number
  updatedAt: number
  title: string

  private readonly cfg: PiConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly hooks: PiRuntimeHooks
  private readonly releases: Pick<PiConfigReleases, 'skillDirs' | 'piConfigDir' | 'notice'> | null
  private readonly clock = new MessageIdClock()
  private state: HarnessState = 'down'
  private startError: string | null = null
  private agent: Agent | null = null
  private models: PiModels | null = null
  private selected: SelectedModel | null = null
  private core: typeof import('@earendil-works/pi-agent-core') | null = null
  private coding: typeof import('@earendil-works/pi-coding-agent') | null = null
  /** bash/read/write/edit/glob/grep: what a child session may be given. */
  private workspaceTools: AgentTool<any, any>[] = []
  /** Workspace tools + `question`: the root's tools before extensions add theirs. */
  private baseTools: AgentTool<any, any>[] = []
  /** pi's AgentSession around `agent`: extensions, prompt expansion, tool registry. */
  private pi: PiSession | null = null
  /** The current ExtensionRunner; pi swaps it on reload, hooks read it at call time. */
  private readonly runner: RunnerRef = {}
  /** The running turn's `system` addition, applied through `before_agent_start`. */
  private turnSystem: string | null = null
  /** Message conversion + extension provider/context hooks a child agent shares with the root. */
  private childAgentOptions: Partial<AgentOptions> = {}
  /** The project package bundle; fetched from construction so the download overlaps the repo clone. */
  private projectBundle: Promise<string | null> | null = null
  private readonly children = new Map<string, ChildSession>()
  private skills: Skill[] = []
  private compiled: CompiledAgentConfig | null = null
  private agentName = 'build'
  private policy: PermissionPolicy = {}
  private adapter: PiTurnEvents | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private active: Turn | null = null
  private runningTools = 0
  private abortAfterTool: { promptId: string; messageId: string } | null = null
  private status: 'idle' | 'busy' = 'idle'
  /** Turns admitted and not yet finished, the running one included. */
  private pendingTurns = 0
  private readonly completedTurns = new Map<string, 'idle' | 'error'>()
  /** The retry state of the root turn in flight (transient-retry.ts). */
  private turnRetry: TransientRetry | null = null
  /** The last assistant message of the root turn in flight. The context is no index: a retry or a compaction rewrites it. */
  private turnAssistant: AgentMessage | null = null
  /** pi already compacted once for the failed attempt in flight; a second failure is final (pi's own rule). */
  private recoveryTried = false
  /** The compaction in flight: its summary message on the wire. */
  private compaction: KortixAssistantMessageInfo | null = null
  private resetProgressWatchdog: (() => void) | null = null
  private workspaceReady = true

  constructor(opts: PiRuntimeOptions) {
    this.cfg = opts.cfg
    this.env = opts.env ?? process.env
    this.now = () => Date.now()
    this.hooks = opts.hooks ?? {}
    this.releases = opts.releases ?? null
    this.rootId = mintRootId(opts.sessionId)
    this.createdAt = this.now()
    this.updatedAt = this.createdAt
    this.title = 'New session'
    this.permissions = new PermissionBroker(this.rootId, (frame) => this.publish(frame), {}, (request) => this.hooks.onPermissionAsked?.(request))
    this.questions = new QuestionBroker(this.rootId, (frame) => this.publish(frame), (request) => {
      this.hooks.onQuestionAsked?.(request, (answers) => void this.questions.reply(request.id, answers))
    })
    void this.prefetchProjectBundle()
  }

  /**
   * The project's packages: npm ones from the pre-built bundle (native import),
   * any it could not serve from the node_modules fallback (fetched only then),
   * and `./` repo paths as they are.
   */
  private async projectPackages(host: typeof import('./extensions/host'), prebuiltRoot: string | null) {
    const entries = host.parseProjectPackages(this.cfg.piPackages)
    if (!prebuiltRoot) return { entries, nodeModulesRoot: null, extensions: [], prebuilt: undefined }
    const { loadPrebuiltPackages } = await import('./extensions/prebuilt')
    const loaded = await loadPrebuiltPackages(prebuiltRoot, entries)
    for (const { entry, reason } of loaded.fallback) {
      logger.warn('[pi] project package loads from the node_modules fallback', { source: typeof entry === 'string' ? entry : entry.source, reason })
    }
    const nodeModulesRoot = loaded.fallback.length
      ? await import('./extensions/bundle').then(({ ensureProjectPackageBundle }) =>
          ensureProjectPackageBundle({ url: this.cfg.piPackagesFallbackUrl, digest: this.cfg.piPackagesBundleDigest, dir: this.cfg.piPackagesDir, kind: 'node_modules' }),
        )
      : null
    const npmName = (entry: (typeof entries)[number]) => host.parseNpmSource(typeof entry === 'string' ? entry : entry.source)?.name
    const fallbackNames = new Set(loaded.fallback.map(({ entry }) => npmName(entry)))
    const local = entries.filter((entry) => !npmName(entry))
    const names = entries.map(npmName).filter((name): name is string => !!name && !fallbackNames.has(name))
    return {
      entries: [...local, ...loaded.fallback.map(({ entry }) => entry)],
      nodeModulesRoot,
      extensions: loaded.extensions,
      prebuilt: { resources: loaded.resources, names },
    }
  }

  /** Start the project bundle download, or join the one in flight. A missing result is retried by the next start. */
  private prefetchProjectBundle(): Promise<string | null> {
    this.projectBundle ??= import('./extensions/bundle')
      .then(({ ensureProjectPackageBundle }) =>
        ensureProjectPackageBundle({ url: this.cfg.piPackagesBundleUrl, digest: this.cfg.piPackagesBundleDigest, dir: this.cfg.piPackagesDir }),
      )
      .then((root) => {
        if (!root) this.projectBundle = null
        return root
      })
    return this.projectBundle
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
      const [{ createPiModels }, { createWorkspaceTools, createQuestionTool }, core, coding, host, { subagents }, prebuiltRoot] = await Promise.all([
        import('./model'),
        import('./tools'),
        import('@earendil-works/pi-agent-core'),
        import('@earendil-works/pi-coding-agent'),
        import('./extensions/host'),
        import('./extensions/subagents'),
        // Started in the constructor: by now it has run beside the repo clone.
        this.prefetchProjectBundle(),
      ])
      this.core = core
      this.coding = coding
      const { convertToLlm } = coding
      this.compiled = parseCompiledAgentConfig(this.env.KORTIX_COMPILED_AGENT_CONFIG)
      this.agentName = this.resolveAgentName()
      this.models = await createPiModels({
        env: this.env,
        defaultModelRef: this.env.KORTIX_MODEL ?? this.compiledAgent()?.model ?? this.compiled?.model ?? null,
      })
      this.selected = this.models.select(nativeModelId(this.env.KORTIX_MODEL) ?? nativeModelId(this.compiledAgent()?.model ?? this.compiled?.model))
      this.adapter = new PiTurnEvents({
        sessionID: this.rootId,
        mintMessageId: () => this.clock.mint(this.now()),
        parentMessageId: () => this.active?.messageId ?? null,
        model: () => ({ providerID: this.selected!.providerID, modelID: this.selected!.modelID }),
        agent: this.agentName,
        workspace: this.workspace,
        now: this.now,
        publish: (frame) => this.publish(frame),
        retryPlan: (message) => retryStatus(this.turnRetry?.plan(message)),
        recovers: (message) => this.recovers(message),
      })
      this.workspaceTools = createWorkspaceTools(this.workspace)
      // The root agent runs parallel-capable; every built-in tool pins its batch to sequential,
      // so only a batch made entirely of parallel tools (task calls) runs concurrently.
      // Every built-in tool is registered; the agent's `tools` switches pick the active ones (rebuildSystemPrompt).
      this.baseTools = [...this.workspaceTools, createQuestionTool(this.questions, (toolCallId) => this.adapter?.toolRef(toolCallId))].map(
        (tool) => ({ ...tool, executionMode: 'sequential' as const }),
      )
      this.skills = await this.loadSkills()
      this.policy = compilePermissionPolicy(this.compiledAgent()?.permission)
      this.permissions.setPolicy(this.policy)
      const restored = this.restore()
      // pi's session store is the model context: the agent's messages are its projection.
      const sessionManager = coding.SessionManager.inMemory(this.workspace, undefined, restored?.entries)
      if (restored && !restored.entries) for (const message of restored.agentMessages) sessionManager.appendMessage(message as never)
      if (this.compiledAgent()?.options) logger.warn('[pi] the agent sets `options`; pi does not apply provider options', { agent: this.agentName })
      const agent = new core.Agent({
        streamFn: withAgentSampling(
          (model, context, options) => this.models!.models.streamSimple(model, context, options),
          () => this.sampling(this.compiledAgent(), this.selected!),
        ),
        convertToLlm,
        toolExecution: 'parallel',
        initialState: {
          systemPrompt: '',
          model: this.selected.model,
          thinkingLevel: this.thinkingLevel(this.compiledAgent()?.variant),
          tools: [],
          messages: sessionManager.buildSessionContext().messages,
        },
        ...host.extensionAgentHooks(this.runner),
      })
      this.agent = agent
      this.childAgentOptions = { convertToLlm, ...host.extensionAgentHooks(this.runner) }
      const extensionsStartedAt = performance.now()
      const project = await this.projectPackages(host, prebuiltRoot)
      this.pi = await host.createPiSession({
        projectConfigDir: await this.projectConfigDir(),
        agent,
        sessionManager,
        ref: this.runner,
        cwd: this.workspace,
        agentDir: this.cfg.piAgentDir,
        projectPackages: project.entries,
        projectBundleRoot: project.nodeModulesRoot,
        prebuilt: project.prebuilt,
        baseTools: this.baseTools,
        extensions: [this.turnExtension(), subagents(this.kortixHost()), ...project.extensions],
        systemPrompt: () => this.systemPrompt(),
        skillAllowed: (name) => skillGranted(this.policy, name),
        provider: this.models.models.getProvider(this.selected.providerID),
      })
      const extensionsMs = performance.now() - extensionsStartedAt
      this.rebuildSystemPrompt()
      // The session installed the extension tool hooks; the permission policy runs first.
      agent.beforeToolCall = this.toolGate((tool, args) => this.compiledAgent()?.tools?.[tool] === false ? 'deny' : this.permissions.rule(tool, args), true, agent.beforeToolCall)
      agent.subscribe((event) => this.onAgentEvent(event))
      this.pi.session.subscribe((event) => this.onSessionEvent(event))
      this.state = 'ok'
      logger.info('[pi] runtime ready', {
        rootId: this.rootId,
        model: `${this.selected.providerID}/${this.selected.modelID}`,
        agent: this.agentName,
        tools: agent.state.tools.map((t) => t.name),
        skills: this.skillList().length,
        extensions: this.pi.status(),
        extensionsMs: Math.round(extensionsMs * 100) / 100,
        restoredMessages: agent.state.messages.length,
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
      env: this.env,
      defaultModelRef: this.env.KORTIX_MODEL ?? this.compiledAgent()?.model ?? this.compiled?.model ?? null,
    })
    this.selected = this.models.select(nativeModelId(this.env.KORTIX_MODEL) ?? nativeModelId(this.compiledAgent()?.model ?? this.compiled?.model))
    this.policy = compilePermissionPolicy(this.compiledAgent()?.permission)
    this.permissions.setPolicy(this.policy)
    this.skills = await this.loadSkills()
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
    this.skills = await this.loadSkills()
    this.rebuildSystemPrompt()
    return this.skills.length
  }

  // ── turns ────────────────────────────────────────────────────────────────

  /** True while a turn runs. */
  busy(): boolean {
    return this.status === 'busy'
  }

  /** No turn running and none admitted behind it: a config applied now reaches the next turn whole. */
  idle(): boolean {
    return this.status === 'idle' && this.pendingTurns === 0
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
    if (input.noReply) {
      // OpenCode `noReply`: the next turn's model sees this message, and none
      // runs now. On the serial queue so it lands between turns, and persisted
      // so a box that sleeps before anyone answers still has it.
      const done = (this.queue = this.queue.then(() => {
        const images = this.images(input)
        const session = this.pi!.session
        session.sessionManager.appendMessage({ role: 'user', content: images.length ? [{ type: 'text', text: input.text }, ...images] : input.text, timestamp: this.now() })
        session.refreshContext()
        this.completedTurns.set(messageId, 'idle')
        this.persist()
      }).catch(() => {}))
      return { messageId, done: done.then(() => 'completed' as TurnOutcome) }
    }
    let resolve!: (outcome: TurnOutcome) => void
    const outcome = new Promise<TurnOutcome>((r) => (resolve = r))
    const turn: Turn = { messageId, input, resolve, outcome }
    this.pendingTurns += 1
    this.queue = this.queue
      .then(() => this.runTurn(turn))
      .catch(() => {})
      .finally(() => {
        this.pendingTurns -= 1
      })
    return { messageId, done: outcome }
  }

  /**
   * Summarize the conversation now (`/session/:id/summarize`). It runs between
   * turns on the serial queue; the wire carries its progress and its result.
   */
  compact(): void {
    if (!this.pi || this.state !== 'ok') throw new PromptRejected('pi runtime is not ready')
    const session = this.pi.session
    this.pendingTurns += 1
    this.queue = this.queue
      .then(() => session.compact())
      // The failure is on the wire (`compaction_end`); nothing else waits for it.
      .catch((err) => logger.warn('[pi] compaction failed', { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        this.pendingTurns -= 1
      })
  }

  /** pi's prompt templates, as the command list a client reads (`GET /command`). */
  commandList(): Array<{ name: string; description: string; source: 'command'; template: string; hints: string[] }> {
    return (this.pi?.session.promptTemplates ?? []).map((template) => ({
      name: template.name,
      description: template.description,
      source: 'command' as const,
      template: template.content,
      hints: [...new Set(template.content.match(/\$(\d+|ARGUMENTS)/g) ?? [])],
    }))
  }

  /** The prompt a `POST /session/:id/command` body asks for: `/name arguments`, which pi expands. */
  commandPrompt(raw: unknown): PromptInput {
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const name = typeof body.command === 'string' ? body.command : ''
    if (!this.commandList().some((command) => command.name === name)) throw new PromptRejected(`unknown command "${name}"`)
    const args = typeof body.arguments === 'string' ? body.arguments.trim() : ''
    const [providerID, ...model] = typeof body.model === 'string' ? body.model.split('/') : []
    return {
      ...parsePromptBody({
        parts: [{ type: 'text', text: `/${name}${args ? ` ${args}` : ''}` }],
        ...(body.messageID !== undefined ? { messageID: body.messageID } : {}),
        ...(body.agent !== undefined ? { agent: body.agent } : {}),
        ...(body.variant !== undefined ? { variant: body.variant } : {}),
        ...(providerID && model.length ? { model: { providerID, modelID: model.join('/') } } : {}),
      }),
      command: true,
    }
  }

  /** Stop the run in flight. Idempotent: aborting an idle agent is a no-op. */
  async abort(): Promise<boolean> {
    this.pi?.session.abortCompaction()
    if (!this.active) return false
    this.permissions.rejectAll()
    this.questions.rejectAll()
    this.turnRetry?.abort()
    this.active.stopRequested = true
    this.stopPi()
    await this.active.outcome
    return true
  }

  /**
   * pi's own stop: the model call, a compaction and the post-run checks. A bare
   * `agent.abort()` lets pi compact (a model call) after the stopped reply.
   */
  private stopPi(): void {
    this.pi?.session.abort().catch((err) => logger.warn('[pi] abort failed', { err: err instanceof Error ? err.message : String(err) }))
  }

  /**
   * Quick Queue: end the named turn once no tool is running. A tool in flight
   * is never killed; the model's own streaming may be cut.
   */
  armAbortAfterTool(input: { promptId: string; runtimeSessionId: string; messageId: string }): void {
    if (input.runtimeSessionId !== this.rootId) return
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
    this.turnAssistant = null
    this.recoveryTried = false
    const retry = new TransientRetry({
      baseDelayMs: this.cfg.piTurnRetryBaseMs,
      contextWindow: () => this.selected?.model.contextWindow ?? 0,
      now: this.now,
    })
    this.turnRetry = retry
    let timedOut = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const armWatchdog = () => {
      clearTimeout(watchdog)
      if (this.runningTools || !this.active || timedOut) return
      watchdog = setTimeout(() => {
        timedOut = true
        turn.stopRequested = true
        retry.abort()
        this.stopPi()
      }, this.cfg.piNoProgressMs)
    }
    this.resetProgressWatchdog = armWatchdog
    try {
      agent.state.model = this.selected!.model
      agent.state.thinkingLevel = this.thinkingLevel(turn.input.variant ?? this.compiledAgent()?.variant)
      this.turnSystem = turn.input.system ?? null
      // pi's prompt path: `input` and `before_agent_start` handlers, extension commands, `/skill:` and templates.
      const images = this.images(turn.input)
      // A transient model error continues the turn instead of ending it (transient-retry.ts).
      armWatchdog()
      await retry.run(agent, () => this.pi!.session.prompt(turn.input.text || '(attachment)', { source: 'rpc', ...(images.length ? { images } : {}) }), () => this.omitFailedAttempt())
      for (const frame of this.adapter!.settleRetry()) this.publish(frame)
      if (timedOut) {
        outcome = 'error'
        const message = 'The session made no progress. Please try again.'
        error = { name: 'TimeoutError', message }
        this.publish({ type: 'session.error', properties: { sessionID: this.rootId, error: { name: 'UnknownError', data: { message } } } })
        this.publish({ type: 'session.status', properties: { sessionID: this.rootId, status: { type: 'idle' } } })
        this.publish({ type: 'session.idle', properties: { sessionID: this.rootId } })
      }
      // Only this turn's messages: an extension command answers without a model call.
      const last = this.turnAssistant as { stopReason?: string; errorMessage?: string } | null
      if (!timedOut && (last?.stopReason === 'aborted' || retry.wasAborted)) outcome = 'aborted'
      else if (!timedOut && last && (last.stopReason === 'error' || last.stopReason === 'length')) {
        outcome = 'error'
        const wire = assistantMessageError({ stopReason: last.stopReason as never, errorMessage: last.errorMessage })
        const data = wire?.data as { message?: string; statusCode?: number } | undefined
        error = wire ? { name: wire.name, message: data?.message, statusCode: data?.statusCode, code: wire.code } : undefined
      }
    } catch (err) {
      outcome = 'error'
      const message = timedOut ? 'The session made no progress. Please try again.' : err instanceof Error ? err.message : String(err)
      error = { name: timedOut ? 'TimeoutError' : 'UnknownError', message }
      this.adapter?.settleRetry()
      logger.error('[pi] turn failed', { messageId: turn.messageId, err: message })
      this.publish({ type: 'session.error', properties: { sessionID: this.rootId, error: { name: 'UnknownError', data: { message } } } })
      this.publish({ type: 'session.status', properties: { sessionID: this.rootId, status: { type: 'idle' } } })
      this.publish({ type: 'session.idle', properties: { sessionID: this.rootId } })
    } finally {
      clearTimeout(watchdog)
      this.resetProgressWatchdog = null
      this.turnRetry = null
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

  /** Omit the failed model attempt from pi's session store, so the retry does not send it again. */
  private omitFailedAttempt(): void {
    const session = this.pi!.session
    const failed = session.sessionManager.getBranch().findLast((entry) => entry.type === 'message')
    if (failed?.type === 'message' && failed.message.role === 'assistant') session.sessionManager.appendContextEdit(failed.id, null)
    session.refreshContext()
  }

  /**
   * pi compacts and retries a failed model attempt once: a context overflow, or
   * a reply cut by the length limit. True for the attempt it will try to recover.
   */
  private recovers(message: AgentMessage): boolean {
    // ponytail: a step that a Kortix retry continued runs outside pi's prompt loop, so pi does not
    // compact after it and the error is final. Move the retry into pi's loop (`agent_before_settle`) to recover it too.
    if (this.turnRetry?.retried) return false
    if (this.recoveryTried || !this.pi?.session.autoCompactionEnabled || message.role !== 'assistant') return false
    if (message.stopReason !== 'length' && !isContextOverflow(message, this.selected?.model.contextWindow ?? 0)) return false
    this.recoveryTried = true
    return true
  }

  /**
   * pi's compaction on the wire, in OpenCode's shape: a user message whose one
   * part is `compaction` (the request), an assistant message flagged `summary`
   * that ends with the summary text or an error, `time.compacting` on the
   * session while it runs, and `session.compacted` when it is over. The
   * transcript keeps every message; only the model's context gets shorter.
   */
  private onSessionEvent(event: AgentSessionEvent): void {
    const sessionID = this.rootId
    if (event.type === 'compaction_start') {
      const created = this.now()
      const markerId = this.clock.mint(created)
      const model = { providerID: this.selected!.providerID, modelID: this.selected!.modelID }
      this.compaction = {
        id: this.clock.mint(created),
        role: 'assistant',
        sessionID,
        parentID: markerId,
        summary: true,
        time: { created },
        ...model,
        ...assistantInfoFields(undefined, { agent: this.agentName, workspace: this.workspace }),
      }
      this.publishSessionUpdated()
      this.publish({ type: 'message.updated', properties: { sessionID, info: { id: markerId, role: 'user', sessionID, time: { created }, agent: this.agentName, model } } })
      this.publish({
        type: 'message.part.updated',
        properties: {
          sessionID,
          time: created,
          part: { id: `${markerId}-p0`, messageID: markerId, sessionID, type: 'compaction', auto: event.reason !== 'manual', ...(event.reason === 'overflow' ? { overflow: true } : {}) },
        },
      })
      this.publish({ type: 'message.updated', properties: { sessionID, info: this.compaction } })
      return
    }
    if (event.type !== 'compaction_end' || !this.compaction) return
    const info = this.compaction
    this.compaction = null
    const completed = this.now()
    const error: KortixMessageError | undefined = event.result
      ? undefined
      : event.aborted
        ? { name: 'MessageAbortedError', data: { message: 'The compaction was stopped' }, code: 'aborted' }
        : { name: 'UnknownError', data: { message: event.errorMessage ?? 'The compaction failed' } }
    if (event.result) {
      this.publish({
        type: 'message.part.updated',
        properties: { sessionID, time: completed, part: { id: `${info.id}-p0`, messageID: info.id, sessionID, type: 'text', text: event.result.summary } },
      })
    }
    this.publish({
      type: 'message.updated',
      properties: {
        sessionID,
        info: {
          ...info,
          ...assistantInfoFields(event.result?.usage, { agent: this.agentName, workspace: this.workspace }),
          time: { created: info.time.created, completed },
          ...(error ? { error } : {}),
        },
      },
    })
    this.publishSessionUpdated()
    this.publish({ type: 'session.compacted', properties: { sessionID } })
    this.persist()
  }

  /** The session row changed (`time.compacting`). */
  private publishSessionUpdated(): void {
    this.publish({ type: 'session.updated', properties: { sessionID: this.rootId, info: this.sessionObject() } })
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === 'agent_start' && this.active?.stopRequested) this.stopPi()
    if (event.type === 'message_start' && event.message.role === 'user' && this.active?.input.command) {
      const { content } = event.message
      const text = typeof content === 'string' ? content : content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      const messageID = this.active.messageId
      this.publish({ type: 'message.part.updated', properties: { sessionID: this.rootId, time: this.now(), part: { id: `${messageID}-p0`, messageID, sessionID: this.rootId, type: 'text', text } } })
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      // pi-ai reports a request that the stop cancelled before it went out as an error ("The operation was aborted.").
      if (event.message.stopReason === 'error' && this.active?.stopRequested) event.message.stopReason = 'aborted'
      this.turnAssistant = event.message
      if (event.message.stopReason !== 'error' && event.message.stopReason !== 'length') this.recoveryTried = false
    }
    if (event.type === 'tool_execution_start') this.runningTools += 1
    if (event.type === 'tool_execution_end') this.runningTools = Math.max(0, this.runningTools - 1)
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'message_update') this.resetProgressWatchdog?.()
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

  /**
   * Re-read the base system prompt (compiled agent, skills) into pi's session,
   * with the built-in tools the agent's `tools` switches leave on. A switch
   * back on re-activates the tool in place: every built-in stays registered.
   */
  private rebuildSystemPrompt(): void {
    const session = this.pi?.session
    if (!session) return
    const switches = this.compiledAgent()?.tools
    // ponytail: a pi package that deactivates a built-in gets it back on the next rebuild; remember package choices if one ever does.
    const builtIn = this.baseTools.map((tool) => tool.name)
    const others = session.getActiveToolNames().filter((name) => !builtIn.includes(name))
    session.setActiveToolsByName([...builtIn.filter((name) => switches?.[name] !== false), ...others])
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
        transcript: new TranscriptStore(),
        agentMessages: [],
        agent: null,
      }
      this.children.set(child.id, child)
      this.publish({ type: 'session.created', properties: { sessionID: child.id, info: this.childSessionObject(child) } })
    }
    const selected = input.model ? this.models.select(nativeModelId(input.model)) : this.selected
    const model = { providerID: selected.providerID, modelID: selected.modelID }
    const tools = (input.tools ? this.workspaceTools.filter((tool) => input.tools!.includes(tool.name)) : this.workspaceTools)
      .filter((tool) => this.compiled?.agent?.[input.agent]?.tools?.[tool.name] !== false)
    const policy = compilePermissionPolicy(input.permission)
    const messageId = this.clock.mint(this.now())
    this.publishUserMessage(child.id, messageId, { messageID: messageId, text: input.prompt, files: [] }, { agent: input.agent, selected })
    const retry = new TransientRetry({ baseDelayMs: this.cfg.piTurnRetryBaseMs, contextWindow: () => selected.model.contextWindow ?? 0, now: this.now })
    const adapter = new PiTurnEvents({
      sessionID: child.id,
      mintMessageId: () => this.clock.mint(this.now()),
      parentMessageId: () => messageId,
      model: () => model,
      agent: input.agent,
      workspace: this.workspace,
      now: this.now,
      publish: (frame) => this.publish(frame),
      retryPlan: (message) => retryStatus(retry.plan(message)),
    })
    const agent = new core.Agent({
      streamFn: withAgentSampling(
        (m, context, options) => this.models!.models.streamSimple(m, context, options),
        () => this.sampling(this.compiled?.agent?.[input.agent], selected),
      ),
      toolExecution: 'sequential',
      initialState: {
        systemPrompt: this.systemPrompt({ base: input.systemPrompt, tools, policy, interactive: false }),
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
      if (own === 'deny' || session === 'deny' || this.compiledAgent()?.tools?.[tool] === false || this.compiled?.agent?.[input.agent]?.tools?.[tool] === false) return 'deny'
      return own ?? session
    }, false, this.childExtensionGate())
    agent.subscribe((event) => {
      for (const frame of adapter.translate(event)) this.publish(frame, frame.transcriptOnly ? { transcriptOnly: true } : undefined)
    })
    child.agent = agent
    input.onSession?.({ sessionId: child.id, model })
    const abort = () => {
      retry.abort()
      agent.abort()
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    let status: SpawnSessionResult['status'] = 'completed'
    let error: string | undefined
    let text = ''
    try {
      if (input.signal?.aborted) status = 'aborted'
      else {
        await retry.run(agent, () => agent.prompt({ role: 'user', content: input.prompt, timestamp: this.now() }))
        for (const frame of adapter.settleRetry()) this.publish(frame)
        const last = [...agent.state.messages].reverse().find((m) => m.role === 'assistant') as
          | { stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }
          | undefined
        text = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
        if (last?.stopReason === 'aborted' || retry.wasAborted) status = 'aborted'
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
  childSession(id: string): { object: Record<string, unknown>; transcript: TranscriptStore } | null {
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
    let frames: TurnEventEmission[]
    try {
      frames = this.adapter.translate(event)
    } catch (err) {
      logger.warn('[pi] wire translation failed', { type: event.type, err: (err as Error).message })
      return
    }
    for (const frame of frames) this.publish(frame, frame.transcriptOnly ? { transcriptOnly: true } : undefined)
  }

  /** Sequence one wire frame onto the bus AND fold it into the transcript. */
  publish(frame: RuntimeFrame, opts: { transcriptOnly?: boolean; busOnly?: boolean } = {}): void {
    const p = frame.properties as Record<string, unknown>
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
    this.hooks.onFrame?.(frame)
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

  /** The session's agent; `default` (no agent chosen) is the manifest's `default_agent`, as on OpenCode. */
  private resolveAgentName(): string {
    const requested = (this.env.KORTIX_AGENT_NAME ?? '').trim()
    const agents = Object.keys(this.compiled?.agent ?? {})
    if (requested && requested !== 'default' && (agents.length === 0 || agents.includes(requested))) return requested
    const declared = this.compiled?.default_agent
    if (declared && agents.includes(declared)) return declared
    return agents[0] ?? 'build'
  }

  private compiledAgent(): CompiledAgent | undefined {
    return this.compiled?.agent?.[this.agentName]
  }

  /** An agent's `temperature`, `top_p` and `steps` for its requests on `model`. */
  private sampling(agent: CompiledAgent | undefined, model: SelectedModel) {
    return {
      temperature: agent?.temperature,
      top_p: agent?.top_p,
      steps: agent?.steps,
      acceptsTemperature: this.models?.catalog[model.modelID]?.temperature !== false,
    }
  }

  private thinkingLevel(variant: string | undefined, selected: SelectedModel | null = this.selected): ModelThinkingLevel {
    if (!selected || !variant) return 'off'
    return selected.variants.includes(variant) ? (variant as ModelThinkingLevel) : 'off'
  }

  /** The pi-native config dir: the release's `pi/` while a release runs, else the working tree's. */
  private async projectConfigDir(): Promise<string | null> {
    const released = this.releases?.piConfigDir()
    return released !== undefined ? released : resolvePiProjectConfigDir(this.cfg)
  }

  private async loadSkills(): Promise<Skill[]> {
    if (!this.coding) return []
    const dirs = resolvePiSkillDirectories(this.cfg, await this.projectConfigDir(), this.releases?.skillDirs() ?? null).filter((dir) => existsSync(dir))
    if (dirs.length === 0) return []
    try {
      // Two directories can carry the same skill (a project's OpenCode copy and the managed
      // overlay): the first directory wins, like OpenCode's search order. pi reports the loser.
      const { skills, diagnostics } = this.coding.loadSkills({ cwd: this.workspace, agentDir: this.cfg.piAgentDir, skillPaths: dirs, includeDefaults: false })
      for (const diagnostic of diagnostics) if (diagnostic.type !== 'collision') logger.warn('[pi] skill diagnostic', diagnostic)
      return skills
    } catch (err) {
      logger.warn('[pi] skill load failed', { err: (err as Error).message })
      return []
    }
  }

  /**
   * The root's system prompt; a child passes its own base prompt, tools and
   * permission policy, and cannot ask questions. Each agent lists only the
   * skills its own grant allows.
   */
  private systemPrompt(
    child?: { base: string; tools: AgentTool<any, any>[]; policy: PermissionPolicy; interactive: false },
  ): string {
    const parts = [child?.base || this.compiledAgent()?.prompt?.trim() || DEFAULT_SYSTEM_PROMPT]
    // pi appends the working directory (and package skills) to the root's prompt.
    if (child) parts.push(`Working directory: ${this.workspace}`)
    const skills = this.skills.filter((skill) => skillGranted(child?.policy ?? this.policy, skill.name))
    if (skills.length > 0) parts.push(this.coding!.formatSkillsForPrompt(skills))
    const capabilities = this.readInstruction(SECRET_CAPABILITIES_INSTRUCTION_PATH)
    if (capabilities) parts.push(capabilities)
    const releaseNotice = this.releases?.notice()
    if (releaseNotice) parts.push(releaseNotice)
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

  /** The agent's granted skills: Kortix skills first, then skills pi loaded from packages; a name appears once. */
  skillList(): Array<Pick<Skill, 'name' | 'description' | 'filePath'>> {
    const own = this.skills.filter((skill) => skillGranted(this.policy, skill.name))
    const seen = new Set(own.map((skill) => skill.name))
    return [...own, ...(this.pi?.skills() ?? []).filter((skill) => !seen.has(skill.name) && (seen.add(skill.name), true))]
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
      time: { created: this.createdAt, updated: this.updatedAt, ...(this.compaction ? { compacting: this.compaction.time.created } : {}) },
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
      schema: KORTIX_RUNTIME_SCHEMA,
      epoch: bus.epoch,
      seq: bus.headSeq,
      built_at: new Date(this.now()).toISOString(),
      identity: {
        harness: 'pi',
        runtime_session_id: this.rootId,
        harness_version: PI_HARNESS_VERSION,
        daemon_build: null,
        agent_config_etag: this.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
        head_seq: null,
      },
      agents: { known: true, value: agents },
      commands: {
        known: true,
        value: this.commandList().map(({ template, ...command }) => ({ ...command, agent: null, model: null, subtask: null, template_bytes: template.length })),
      },
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
            time: { created: this.createdAt, updated: this.updatedAt, compacting: this.compaction?.time.created ?? null, archived: null },
            revert: null,
          },
          ...[...this.children.values()].map((child) => ({
            id: child.id,
            title: child.title,
            parent_id: this.rootId,
            directory: this.workspace,
            time: { created: child.createdAt, updated: child.updatedAt, compacting: null, archived: null },
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
   * The turn probe behind `/kortix/health?turn=1`.
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
        ...(this.pi ? { entries: this.pi.session.sessionManager.getEntries() } : {}),
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
        const transcript = new TranscriptStore()
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
