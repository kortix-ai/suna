import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

import { logger } from '../logger'
import { mergeProjectEnv, type ProjectEnvStore } from '../project-env'
import type {
  AcpHarnessDescriptor,
  AcpHarnessId,
  AcpHarnessRegistry,
} from './harness-registry'

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
const HARNESS_CONFIG_DIR_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
] as const

export function redactHarnessStderr(line: string, env: NodeJS.ProcessEnv): string {
  let redacted = line
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_NAME.test(name) || !value || value.length < 6) continue
    redacted = redacted.replaceAll(value, '[REDACTED]')
  }
  return redacted
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
    if (!existsSync(file)) writeFileSync(file, `${managedModels}\n`, { mode: 0o600 })
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

class AcpProcess {
  readonly createdAt = new Date()
  readonly descriptor: AcpHarnessDescriptor
  readonly serverId: string

  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscribers = new Set<Subscriber>()
  private readonly replay: AcpStreamEvent[] = []
  private readonly stderrTail: string[] = []
  private nextEventId = 1
  private writeQueue = Promise.resolve()
  private exited = false
  private readonly onUnexpectedExit: (process: AcpProcess) => void

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
    const childEnv = { ...options.env, ...options.descriptor.launch.env }
    ensureHarnessConfigDirs(childEnv, options.cwd)
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

    const isMethodCall = typeof envelope.method === 'string'
    const hasId = Object.prototype.hasOwnProperty.call(envelope, 'id')
    if (!isMethodCall || !hasId) {
      await this.write(envelope)
      return null
    }

    const key = rpcIdKey(envelope.id)
    if (this.pending.has(key)) throw new Error(`duplicate in-flight JSON-RPC id ${key}`)

    const response = new Promise<JsonRpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new AcpUpstreamError(`timed out waiting for ACP response to id ${key}`))
      }, DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(key, { resolve, reject, timer })
    })

    try {
      await this.write(envelope)
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

  subscribe(
    afterEventId: number,
    event: Subscriber['event'],
    close: Subscriber['close'] = () => {},
  ): () => void {
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
        pending.resolve(envelope)
        return
      }
    }

    const event = { id: this.nextEventId++, envelope }
    this.replay.push(event)
    if (this.replay.length > MAX_REPLAY_EVENTS) this.replay.shift()
    for (const subscriber of this.subscribers) subscriber.event(event)
  }

  private fail(error: Error): void {
    if (this.exited) return
    this.exited = true
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
      const env = this.options.projectEnv
        ? mergeProjectEnv(baseEnv, this.options.projectEnv)
        : baseEnv
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
    super(
      `ACP server '${serverId}' already uses '${existingHarness}', not '${requestedHarness}'`,
    )
  }
}

export class AcpUpstreamError extends Error {}
