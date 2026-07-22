import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

import { logger } from '../logger'
import { mergeProjectEnv, type ProjectEnvStore } from '../project-env'
import { gitIgnoredSet } from '../routes/files'
import { applyAcpSessionDefaults, isolateHarnessAuthEnv, resolveAcpHarnessLaunchEnv, type AcpHarnessDescriptor, type AcpHarnessId, type AcpHarnessRegistry } from './harness-registry'
import { OutputScanTracker } from './output-scan'

export type JsonRpcEnvelope = Record<string, unknown> & { jsonrpc: '2.0' }

export type AcpStreamEvent = {
  id: number
  envelope: JsonRpcEnvelope
}

export type AcpRuntimeInstanceInfo = {
  serverId: string
  harness: AcpHarnessId
  pid: number | null
  createdAt: string
  busy: boolean
}

type PendingRequest = {
  resolve(value: JsonRpcEnvelope): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  /** The outbound method this request was for — only `session/prompt`
   *  responses are checked for the hollow-completion pattern below. */
  method?: string
  /** Whether the outbound `session/prompt` actually carried non-empty
   *  content. A prompt with nothing in it legitimately CAN end in a
   *  zero-token turn — only a real prompt going hollow is suspicious. */
  promptHadContent?: boolean
  /** The `params.sessionId` an outbound `session/prompt` targeted. Used to
   *  look up the assembled agent-message text for that turn when checking
   *  the codex error-as-content pattern (see `upstreamErrorDetail`). */
  promptSessionId?: string
}

type Subscriber = {
  event: (event: AcpStreamEvent) => void
  close: () => void
}

const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const MAX_REPLAY_EVENTS = 2_000
const MAX_STDERR_LINES = 100
const SENSITIVE_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH)/i
const HARNESS_CONFIG_DIR_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'] as const
const SERVER_SIDE_AUTH_ENV = ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON'] as const

export function sanitizeHarnessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const name of SERVER_SIDE_AUTH_ENV) delete out[name]
  return out
}

export function redactHarnessStderr(line: string, env: NodeJS.ProcessEnv): string {
  let redacted = line
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_NAME.test(name) || !value || value.length < 6) continue
    redacted = redacted.replaceAll(value, '[REDACTED]')
  }
  return redacted
}

export function materializeHarnessLaunchConfig(
  harness: AcpHarnessId,
  env: NodeJS.ProcessEnv,
): void {
  if (harness !== 'opencode') return
  const content = env.OPENCODE_CONFIG_CONTENT
  if (!content) return

  const dir = join(env.HOME || '/opt/kortix/home', '.config', 'kortix')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'kortix-opencode.json')
  const temporaryFile = join(dir, `.kortix-opencode.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryFile, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporaryFile, file)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
  env.OPENCODE_CONFIG = file
  delete env.OPENCODE_CONFIG_CONTENT
}

export function ensureHarnessConfigDirs(env: NodeJS.ProcessEnv, cwd: string): void {
  for (const name of HARNESS_CONFIG_DIR_ENV) {
    const raw = env[name]?.trim()
    if (!raw) continue
    mkdirSync(isAbsolute(raw) ? raw : join(cwd, raw), { recursive: true })
  }
  const piDir = env.PI_CODING_AGENT_DIR?.trim()
  const managedModels = env.KORTIX_PI_MODELS_JSON?.trim()
  if (piDir && managedModels) {
    const dir = isAbsolute(piDir) ? piDir : join(cwd, piDir)
    const file = join(dir, 'models.json')
    try {
      writeFileSync(file, `${managedModels}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
  }
}

function rpcIdKey(id: unknown): string {
  return JSON.stringify(id)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJsonRpcEnvelope(value: unknown): JsonRpcEnvelope {
  if (!isObject(value) || value.jsonrpc !== '2.0') {
    throw new Error('request body must be a JSON-RPC 2.0 object')
  }
  const hasMethod = typeof value.method === 'string' && value.method.length > 0
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id')
  const isResponse = hasId && (Object.prototype.hasOwnProperty.call(value, 'result') || Object.prototype.hasOwnProperty.call(value, 'error'))
  if (!hasMethod && !isResponse) {
    throw new Error('JSON-RPC envelope must be a request, notification, or response')
  }
  return value as JsonRpcEnvelope
}

/** True if an outbound `session/prompt`'s `params.prompt` carries at least
 *  one non-empty content block (text or otherwise). A prompt with nothing
 *  in it can legitimately end a turn with zero usage — only a REAL prompt
 *  going hollow (see `isHollowPromptCompletion`) is a harness bug. */
function promptHasContent(envelope: JsonRpcEnvelope): boolean {
  const params = isObject(envelope.params) ? envelope.params : {}
  const blocks = Array.isArray(params.prompt) ? params.prompt : []
  return blocks.some((block) => {
    if (!isObject(block)) return false
    if (typeof block.text === 'string') return block.text.trim().length > 0
    // Any non-text block (image/resource/etc.) counts as real content.
    return typeof block.type === 'string' && block.type !== 'text'
  })
}

/**
 * Detects a harness completing a `session/prompt` turn WITHOUT ever calling
 * a model: `result.stopReason` reports a normal completion (`end_turn`) but
 * `result.usage` is entirely zero. A genuine model call always consumes at
 * least the prompt's input tokens, so all-zero usage after real content was
 * sent means no upstream request was ever made — the harness silently
 * no-op'd instead of surfacing whatever stopped it (e.g. OpenCode 1.17.11
 * swallowing a 400 from Anthropic's `thinking.type=enabled` deprecation
 * for newer Claude models — see the regression test for the full story).
 *
 * Deliberately narrow: only `end_turn` trips this (not `cancelled`, which
 * legitimately reports zero usage when the user cancels before the model
 * responds, mirroring `OutputScanTracker.noteResponse`'s same carve-out;
 * and not `max_tokens`/`refusal`/other terminal reasons, which imply SOME
 * upstream attempt happened). Fail-fast mandate: a hollow completion must
 * never look like a normal, silent, empty response to the user.
 */
function isHollowPromptCompletion(pending: PendingRequest, envelope: JsonRpcEnvelope): boolean {
  if (pending.method !== 'session/prompt' || !pending.promptHadContent) return false
  if (Object.prototype.hasOwnProperty.call(envelope, 'error')) return false
  const result = isObject(envelope.result) ? envelope.result : null
  if (!result || result.stopReason !== 'end_turn') return false
  const usage = isObject(result.usage) ? result.usage : null
  if (!usage) return false
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : 0
  return inputTokens === 0 && outputTokens === 0 && totalTokens === 0
}

/** Rewrites a hollow completion into a genuine JSON-RPC error. This reuses
 *  the SDK's EXISTING error path end to end — `AcpClient.request()` already
 *  throws `AcpRpcError` on any `envelope.error` (client.ts), and
 *  `AcpSession.send()` already catches that and patches `snapshot.error`
 *  (session.ts) — so no client/composer change is needed to make this
 *  visible; it rides the same rail a real upstream rejection would. */
function toHollowPromptError(envelope: JsonRpcEnvelope): JsonRpcEnvelope {
  return {
    jsonrpc: '2.0',
    id: envelope.id,
    error: {
      code: -32001,
      message:
        'The agent ended the turn without producing a response (zero tokens used). ' +
        'This usually means the harness could not reach the model — check the ' +
        "session's model/provider connection and try again.",
      data: { kortix: { reason: 'hollow_prompt_completion' } },
    },
  }
}

/** The small set of keys an upstream JSON error envelope is allowed to carry
 *  and still be treated as "an error delivered as content" — not a real
 *  answer. The proven-live Codex/ChatGPT rejection shape is exactly
 *  `{"detail":"…"}`; the others are conservative room for the same class of
 *  provider error body without ever matching a domain answer. */
const UPSTREAM_ERROR_ENVELOPE_KEYS = new Set(['detail', 'error', 'code', 'type', 'status', 'message'])

/**
 * Returns the human-readable `detail` when `text` is, IN ITS ENTIRETY, an
 * upstream error envelope that a harness delivered as assistant message
 * content instead of surfacing as a JSON-RPC error — else `null`.
 *
 * This is the codex-path blind spot the hollow guard cannot see: when the
 * Codex/ChatGPT backend rejects a request (e.g. an unsupported model), the
 * subscription relay forwards its `{"detail":"…"}` body and codex-acp streams
 * that raw JSON as an `agent_message_chunk` + `end_turn` — a turn WITH content
 * and (often) non-zero usage, so it reads as a normal successful answer.
 *
 * Deliberately STRICT so it can never clip a real answer that merely contains
 * JSON: the WHOLE trimmed turn must parse to a plain object that carries a
 * non-empty string `detail`, and every one of its keys must be an
 * error-envelope key (never a domain field). A real coding answer — even one
 * that is itself valid JSON — carries domain keys and fails this check.
 */
export function upstreamErrorDetail(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed[0] !== '{' || trimmed[trimmed.length - 1] !== '}') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const detail = parsed.detail
  if (typeof detail !== 'string' || detail.trim().length === 0) return null
  if (!Object.keys(parsed).every((key) => UPSTREAM_ERROR_ENVELOPE_KEYS.has(key))) return null
  return detail.trim()
}

/** Rewrites a turn whose entire assistant message was an upstream error
 *  envelope (see `upstreamErrorDetail`) into a genuine JSON-RPC error, so the
 *  UI shows a real failure instead of rendering the raw provider rejection as
 *  if it were the model's answer. Rides the same existing `AcpRpcError` rail
 *  as `toHollowPromptError` — no client/composer change needed. */
function toUpstreamContentError(envelope: JsonRpcEnvelope, detail: string): JsonRpcEnvelope {
  return {
    jsonrpc: '2.0',
    id: envelope.id,
    error: {
      code: -32002,
      message: `The model provider rejected this request: ${detail}`,
      data: { kortix: { reason: 'upstream_error_content' } },
    },
  }
}

/** The `params.sessionId` an outbound `session/prompt` targets, if any. */
function promptSessionId(envelope: JsonRpcEnvelope): string | undefined {
  const params = isObject(envelope.params) ? envelope.params : {}
  return typeof params.sessionId === 'string' ? params.sessionId : undefined
}

/** The assistant text carried by an inbound `agent_message_chunk` update
 *  (the only content kind whose accumulation matters for the error-as-content
 *  check), keyed for accumulation by its `params.sessionId`. */
function agentMessageChunkText(envelope: JsonRpcEnvelope): { sessionId: string; text: string } | null {
  if (envelope.method !== 'session/update') return null
  const params = isObject(envelope.params) ? envelope.params : null
  if (!params || typeof params.sessionId !== 'string') return null
  const update = isObject(params.update) ? params.update : null
  if (!update || update.sessionUpdate !== 'agent_message_chunk') return null
  const content = isObject(update.content) ? update.content : null
  if (!content || content.type !== 'text' || typeof content.text !== 'string') return null
  return { sessionId: params.sessionId, text: content.text }
}

class AcpProcess {
  readonly createdAt = new Date()
  readonly descriptor: AcpHarnessDescriptor
  readonly serverId: string

  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  /** Accumulated `agent_message_chunk` text for the in-flight prompt turn of
   *  each session, keyed by sessionId. Only populated for the codex harness —
   *  the one path whose adapter leaks upstream error bodies as message content
   *  (see `upstreamErrorDetail`). Reset when a prompt starts, read + cleared
   *  when it completes. */
  private readonly codexTurnText = new Map<string, string>()
  private readonly subscribers = new Set<Subscriber>()
  private readonly replay: AcpStreamEvent[] = []
  private readonly stderrTail: string[] = []
  private nextEventId = 1
  private writeQueue = Promise.resolve()
  private exited = false
  private readonly onUnexpectedExit: (process: AcpProcess) => void
  private readonly sessionDefaultsEnv: NodeJS.ProcessEnv
  private readonly outputScan: OutputScanTracker

  constructor(options: {
    serverId: string
    descriptor: AcpHarnessDescriptor
    cwd: string
    env: NodeJS.ProcessEnv
    onUnexpectedExit(process: AcpProcess): void
  }) {
    this.serverId = options.serverId
    this.descriptor = options.descriptor
    this.onUnexpectedExit = options.onUnexpectedExit
    // Project secrets arrive through env sync after daemon boot. Resolve the
    // harness auth route now from that current snapshot.
    const isolatedEnv = isolateHarnessAuthEnv(options.env)
    const launchEnv = resolveAcpHarnessLaunchEnv(options.descriptor.id, isolatedEnv)
    const childEnv = sanitizeHarnessEnv({ ...isolatedEnv, ...launchEnv })
    ensureHarnessConfigDirs(childEnv, options.cwd)
    materializeHarnessLaunchConfig(options.descriptor.id, childEnv)
    this.sessionDefaultsEnv = childEnv
    this.child = spawn(options.descriptor.launch.command, options.descriptor.launch.args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdout = createInterface({ input: this.child.stdout })
    stdout.on('line', (line) => this.onStdoutLine(line))

    const stderr = createInterface({ input: this.child.stderr })
    stderr.on('line', (line) => {
      const safeLine = redactHarnessStderr(line, childEnv)
      this.stderrTail.push(safeLine)
      if (this.stderrTail.length > MAX_STDERR_LINES) this.stderrTail.shift()
      logger.warn('[acp] harness stderr', {
        serverId: this.serverId,
        harness: this.descriptor.id,
        line: safeLine,
      })
    })

    this.child.once('error', (error) => this.fail(error))
    this.child.once('exit', (code, signal) => {
      const stderrSummary = this.stderrTail.slice(-20).join('\n')
      this.fail(
        new Error(
          `ACP harness '${this.descriptor.id}' exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${stderrSummary ? `: ${stderrSummary}` : ''}`,
        ),
      )
    })

    this.outputScan = new OutputScanTracker({
      workspace: options.cwd,
      publish: (envelope) => { if (!this.exited) this.publish(envelope) },
      isIgnored: (absPaths) => gitIgnoredSet(options.cwd, absPaths),
    })
  }

  get pid(): number | null {
    return this.child.pid ?? null
  }

  get busy(): boolean {
    return this.pending.size > 0
  }

  async post(envelope: JsonRpcEnvelope): Promise<JsonRpcEnvelope | null> {
    if (this.exited) {
      throw new AcpUpstreamError(`ACP harness '${this.descriptor.id}' is not running`)
    }

    const outbound = applyAcpSessionDefaults(this.descriptor.id, envelope, this.sessionDefaultsEnv)
    this.outputScan.noteOutbound(outbound)
    const isMethodCall = typeof outbound.method === 'string'
    const hasId = Object.prototype.hasOwnProperty.call(envelope, 'id')
    if (!isMethodCall || !hasId) {
      await this.write(outbound)
      return null
    }

    const key = rpcIdKey(envelope.id)
    if (this.pending.has(key)) throw new Error(`duplicate in-flight JSON-RPC id ${key}`)

    const method = typeof outbound.method === 'string' ? outbound.method : undefined
    const promptHadContent = method === 'session/prompt' ? promptHasContent(outbound) : undefined
    const promptSession = method === 'session/prompt' ? promptSessionId(outbound) : undefined
    // A new codex prompt turn starts here: clear whatever assistant text a
    // previous turn on this session left behind so the error-as-content check
    // only ever inspects THIS turn's message.
    if (this.descriptor.id === 'codex' && promptSession) this.codexTurnText.set(promptSession, '')
    const response = new Promise<JsonRpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new AcpUpstreamError(`timed out waiting for ACP response to id ${key}`))
      }, DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(key, { resolve, reject, timer, method, promptHadContent, promptSessionId: promptSession })
    })

    try {
      await this.write(outbound)
    } catch (error) {
      const pending = this.pending.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(key)
        pending.reject(new AcpUpstreamError(error instanceof Error ? error.message : String(error)))
      }
    }
    return response
  }

  subscribe(afterEventId: number, event: Subscriber['event'], close: Subscriber['close'] = () => {}): () => void {
    for (const replayed of this.replay) {
      if (replayed.id > afterEventId) event(replayed)
    }
    const subscriber = { event, close }
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  async stop(): Promise<void> {
    if (this.exited) return
    this.exited = true
    this.outputScan.dispose()
    this.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 2_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.rejectPending(new AcpUpstreamError(`ACP server '${this.serverId}' was stopped`))
    this.closeSubscribers()
  }

  private async write(envelope: JsonRpcEnvelope): Promise<void> {
    const line = `${JSON.stringify(envelope)}\n`
    const write = async () => {
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
      })
    }
    const queued = this.writeQueue.then(write, write)
    this.writeQueue = queued.catch(() => {})
    return queued
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let envelope: JsonRpcEnvelope
    try {
      envelope = parseJsonRpcEnvelope(JSON.parse(trimmed))
    } catch (error) {
      logger.warn('[acp] ignored invalid harness stdout', {
        serverId: this.serverId,
        harness: this.descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const hasMethod = typeof envelope.method === 'string'
    const hasId = Object.prototype.hasOwnProperty.call(envelope, 'id')
    if (!hasMethod && hasId) {
      const pending = this.pending.get(rpcIdKey(envelope.id))
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(rpcIdKey(envelope.id))
        this.outputScan.noteResponse(envelope)
        if (isHollowPromptCompletion(pending, envelope)) {
          logger.warn('[acp] hollow session/prompt completion — end_turn with zero usage; surfacing as an error instead of silent success', {
            serverId: this.serverId,
            harness: this.descriptor.id,
          })
          pending.resolve(toHollowPromptError(envelope))
          return
        }
        const errorContent = this.codexPromptErrorContent(pending, envelope)
        if (errorContent) {
          logger.warn('[acp] codex session/prompt delivered an upstream error envelope as message content; surfacing as an error instead of a fake answer', {
            serverId: this.serverId,
            harness: this.descriptor.id,
          })
          pending.resolve(toUpstreamContentError(envelope, errorContent))
          return
        }
        pending.resolve(envelope)
        return
      }
    }

    if (this.descriptor.id === 'codex') {
      const chunk = agentMessageChunkText(envelope)
      if (chunk && this.codexTurnText.has(chunk.sessionId)) {
        this.codexTurnText.set(chunk.sessionId, (this.codexTurnText.get(chunk.sessionId) ?? '') + chunk.text)
      }
    }
    this.publish(envelope)
    this.outputScan.noteInbound(envelope)
  }

  /** For a completing codex `session/prompt`, returns the upstream error
   *  `detail` when this turn's ENTIRE assistant message was an error envelope
   *  the adapter leaked as content (see `upstreamErrorDetail`), else `null`.
   *  Always consumes this turn's accumulated text so it never leaks into the
   *  next turn (or memory). Never touches a response that already carries an
   *  `error` — that failure is already surfaced correctly. */
  private codexPromptErrorContent(pending: PendingRequest, envelope: JsonRpcEnvelope): string | null {
    if (this.descriptor.id !== 'codex' || pending.method !== 'session/prompt') return null
    const sessionId = pending.promptSessionId
    const turnText = sessionId ? this.codexTurnText.get(sessionId) : undefined
    if (sessionId) this.codexTurnText.delete(sessionId)
    if (Object.prototype.hasOwnProperty.call(envelope, 'error')) return null
    if (!turnText) return null
    return upstreamErrorDetail(turnText)
  }

  private publish(envelope: JsonRpcEnvelope): void {
    const event = { id: this.nextEventId++, envelope }
    this.replay.push(event)
    if (this.replay.length > MAX_REPLAY_EVENTS) this.replay.shift()
    for (const subscriber of this.subscribers) subscriber.event(event)
  }

  private fail(error: Error): void {
    if (this.exited) return
    this.exited = true
    this.outputScan.dispose()
    this.rejectPending(new AcpUpstreamError(error.message))
    this.closeSubscribers()
    this.onUnexpectedExit(this)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
  }
}

export class AcpRuntime {
  private readonly instances = new Map<string, AcpProcess>()
  private readonly creationLocks = new Map<string, Promise<AcpProcess>>()

  constructor(
    private readonly options: {
      registry: AcpHarnessRegistry
      cwd: string
      projectEnv?: ProjectEnvStore
      baseEnv?: NodeJS.ProcessEnv
    },
  ) {}

  list(): AcpRuntimeInstanceInfo[] {
    return [...this.instances.values()]
      .map((instance) => ({
        serverId: instance.serverId,
        harness: instance.descriptor.id,
        pid: instance.pid,
        createdAt: instance.createdAt.toISOString(),
        busy: instance.busy,
      }))
      .sort((a, b) => a.serverId.localeCompare(b.serverId))
  }

  get(serverId: string): AcpProcess | null {
    return this.instances.get(serverId) ?? null
  }

  async getOrCreate(serverId: string, harness: AcpHarnessId | null): Promise<AcpProcess> {
    if (!SERVER_ID_RE.test(serverId)) throw new Error('invalid ACP server id')
    const existing = this.instances.get(serverId)
    if (existing) {
      if (harness && existing.descriptor.id !== harness) {
        throw new AcpHarnessConflictError(serverId, existing.descriptor.id, harness)
      }
      return existing
    }
    if (!harness) throw new Error("first POST must include a supported 'agent' query parameter")

    const pending = this.creationLocks.get(serverId)
    if (pending) return pending

    const creation = Promise.resolve().then(() => {
      const descriptor = this.options.registry.get(harness)
      if (!descriptor) throw new Error(`unsupported ACP agent '${harness}'`)
      const baseEnv = this.options.baseEnv ?? process.env
      const env = this.options.projectEnv ? mergeProjectEnv(baseEnv, this.options.projectEnv) : baseEnv
      const instance = new AcpProcess({
        serverId,
        descriptor,
        cwd: this.options.cwd,
        env,
        onUnexpectedExit: (exited) => {
          if (this.instances.get(serverId) === exited) this.instances.delete(serverId)
        },
      })
      this.instances.set(serverId, instance)
      return instance
    })
    this.creationLocks.set(serverId, creation)
    try {
      return await creation
    } finally {
      this.creationLocks.delete(serverId)
    }
  }

  async delete(serverId: string): Promise<void> {
    const instance = this.instances.get(serverId)
    if (!instance) return
    this.instances.delete(serverId)
    await instance.stop()
  }

  /** Apply newly synchronized credentials without interrupting an active turn.
   * Idle processes are recreated on the next ACP request; busy ones retain
   * their launch snapshot until they become idle or the session is restarted. */
  async recycleIdle(): Promise<{ recycled: string[]; deferred: string[] }> {
    const recycled: string[] = []
    const deferred: string[] = []
    for (const instance of [...this.instances.values()]) {
      if (instance.busy) {
        deferred.push(instance.serverId)
        continue
      }
      await this.delete(instance.serverId)
      recycled.push(instance.serverId)
    }
    return { recycled, deferred }
  }

  async shutdown(): Promise<void> {
    const instances = [...this.instances.values()]
    this.instances.clear()
    await Promise.all(instances.map((instance) => instance.stop()))
  }
}

export class AcpHarnessConflictError extends Error {
  constructor(
    readonly serverId: string,
    readonly existingHarness: AcpHarnessId,
    readonly requestedHarness: AcpHarnessId,
  ) {
    super(`ACP server '${serverId}' already uses '${existingHarness}', not '${requestedHarness}'`)
  }
}

export class AcpUpstreamError extends Error {}
