import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

import { logger } from '../logger'
import { resolveManagedOpencodeLaunchEnv } from '../opencode'
import {
  mergeProjectEnv,
  type ProjectEnvStore,
} from '../project-env'
import {
  AcpConnection,
  type AcpStreamEvent,
  type JsonRpcEnvelope,
  redactAcpDiagnostic,
} from './connection'
import {
  resolveAcpHarnessLaunchEnv,
  type AcpHarnessDescriptor,
  type AcpHarnessId,
  type AcpHarnessRegistry,
} from './harness-registry'

export type AcpRuntimeInstanceInfo = {
  serverId: string
  harness: AcpHarnessId
  pid: number | null
  createdAt: string
  busy: boolean
}

const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HARNESS_CONFIG_DIR_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
] as const

/** Write `file` unless it already exists, so an author-owned config wins. */
function writeConfigIfAbsent(file: string, content: string): void {
  try {
    writeFileSync(file, content, {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      )
    ) {
      throw error
    }
  }
}

function ensureHarnessConfigDirs(
  env: NodeJS.ProcessEnv,
  cwd: string,
): void {
  for (const name of HARNESS_CONFIG_DIR_ENV) {
    const raw = env[name]?.trim()
    if (!raw) continue
    mkdirSync(isAbsolute(raw) ? raw : join(cwd, raw), {
      recursive: true,
    })
  }

  const piDir = env.PI_CODING_AGENT_DIR?.trim()
  if (!piDir) return
  const dir = isAbsolute(piDir) ? piDir : join(cwd, piDir)

  // pi-acp reads `quietStartup` from <PI_CODING_AGENT_DIR>/settings.json and
  // then stops composing the `pi vX.Y.Z` / Context / Skills banner it pushes
  // into the session as an agent message. It also skips that banner's skill
  // directory scan on every session/new. pi-acp 0.0.32 offers no env var for
  // this and still emits the upgrade nag regardless, so this only reduces the
  // noise at the source — AcpConnection's pre-turn guard is what keeps harness
  // chatter out of the transcript.
  writeConfigIfAbsent(
    join(dir, 'settings.json'),
    `${JSON.stringify({ quietStartup: true }, null, 2)}\n`,
  )

  const models = env.KORTIX_PI_MODELS_JSON?.trim()
  if (!models) return
  writeConfigIfAbsent(join(dir, 'models.json'), `${models}\n`)
}

function killProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  child.kill(signal)
}

export class AcpRuntimeProcess {
  readonly createdAt = new Date()
  readonly connection: AcpConnection

  private readonly child: ChildProcessWithoutNullStreams
  private readonly started: Promise<void>
  private stopping = false
  private exited = false

  constructor(
    readonly serverId: string,
    readonly descriptor: AcpHarnessDescriptor,
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      requestTimeoutMs?: number
      initializeOnStart?: boolean
      onStartupMark?: (label: string) => void
      onUnexpectedExit(process: AcpRuntimeProcess): void
    },
  ) {
    const childEnv = {
      ...options.env,
      ...resolveAcpHarnessLaunchEnv(
        descriptor.id,
        options.env,
      ),
    }
    ensureHarnessConfigDirs(childEnv, options.cwd)

    this.child = spawn(
      descriptor.launch.command,
      descriptor.launch.args,
      {
        cwd: options.cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      },
    )
    this.connection = new AcpConnection({
      input: this.child.stdin,
      output: this.child.stdout,
      requestTimeoutMs: options.requestTimeoutMs,
      onDiagnostic: (line) =>
        logger.warn('[acp-runtime] protocol', {
          serverId,
          harness: descriptor.id,
          line,
        }),
      onFirstOutput: () =>
        options.onStartupMark?.('runtime-acp-first-output'),
    })

    const stderr = createInterface({ input: this.child.stderr })
    stderr.on('line', (line) => {
      logger.warn('[acp-runtime] harness stderr', {
        serverId,
        harness: descriptor.id,
        line: redactAcpDiagnostic(line, childEnv),
      })
    })

    const spawned = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', resolve)
      this.child.once('error', reject)
    })
    this.started = spawned.then(async () => {
      options.onStartupMark?.('runtime-process-spawned')
      if (!options.initializeOnStart) return
      await this.connection.initialize({
        clientInfo: {
          name: 'kortix-sandbox-agent-server',
          version: '1',
        },
      })
      options.onStartupMark?.('runtime-acp-initialized')
    })

    this.child.once('error', (error) => {
      this.connection.dispose(
        `ACP harness '${descriptor.id}' failed: ${error.message}`,
      )
    })
    this.child.once('exit', (code, signal) => {
      this.exited = true
      this.connection.dispose(
        `ACP harness '${descriptor.id}' exited ` +
          `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      )
      if (!this.stopping) options.onUnexpectedExit(this)
    })
  }

  get harness(): AcpHarnessId {
    return this.descriptor.id
  }

  get pid(): number | null {
    return this.child.pid ?? null
  }

  get busy(): boolean {
    return this.connection.busy
  }

  async waitUntilStarted(): Promise<void> {
    await this.started
  }

  async post(
    envelope: JsonRpcEnvelope,
  ): Promise<JsonRpcEnvelope | null> {
    const hasMethod =
      typeof envelope.method === 'string' &&
      envelope.method.length > 0
    const hasId = Object.prototype.hasOwnProperty.call(
      envelope,
      'id',
    )
    if (hasMethod && hasId) {
      if (envelope.method === 'initialize') {
        return this.connection.initializeEnvelope(
          envelope.params,
          envelope.id as string | number,
        )
      }
      return this.connection.requestEnvelope(
        envelope.method as string,
        envelope.params,
        envelope.id as string | number,
      )
    }
    await this.connection.post(envelope)
    return null
  }

  subscribe(
    afterEventId: number,
    event: (value: AcpStreamEvent) => void,
    close: () => void = () => {},
  ): () => void {
    return this.connection.subscribe(afterEventId, event, close)
  }

  async stop(): Promise<void> {
    if (this.exited) return
    this.stopping = true
    this.connection.dispose(
      `ACP server '${this.serverId}' was stopped`,
    )

    await new Promise<void>((resolve) => {
      const finish = () => resolve()
      this.child.once('exit', finish)
      try {
        killProcessGroup(this.child, 'SIGTERM')
      } catch {
        resolve()
        return
      }
      setTimeout(() => {
        if (!this.exited) {
          try {
            killProcessGroup(this.child, 'SIGKILL')
          } catch {}
        }
        resolve()
      }, 2_000).unref()
    })
  }
}

export class AcpRuntime {
  private readonly instances = new Map<
    string,
    AcpRuntimeProcess
  >()
  private readonly creationLocks = new Map<
    string,
    {
      harness: AcpHarnessId
      promise: Promise<AcpRuntimeProcess>
    }
  >()

  constructor(
    private readonly options: {
      registry: AcpHarnessRegistry
      cwd: string
      projectEnv?: ProjectEnvStore
      baseEnv?: NodeJS.ProcessEnv
      requestTimeoutMs?: number
      initializeOnCreate?: boolean
      onStartupMark?: (label: string) => void
      /** Overrides where the OpenCode harness's composed config is written. */
      opencodeConfigPath?: string
    },
  ) {}

  list(): AcpRuntimeInstanceInfo[] {
    return [...this.instances.values()]
      .map((instance) => ({
        serverId: instance.serverId,
        harness: instance.harness,
        pid: instance.pid,
        createdAt: instance.createdAt.toISOString(),
        busy: instance.busy,
      }))
      .sort((a, b) => a.serverId.localeCompare(b.serverId))
  }

  get(serverId: string): AcpRuntimeProcess | null {
    return this.instances.get(serverId) ?? null
  }

  async getOrCreate(
    serverId: string,
    harness: AcpHarnessId,
  ): Promise<AcpRuntimeProcess> {
    if (!SERVER_ID_RE.test(serverId)) {
      throw new Error('invalid ACP server id')
    }

    const existing = this.instances.get(serverId)
    if (existing) {
      if (existing.harness !== harness) {
        throw new AcpHarnessConflictError(
          serverId,
          existing.harness,
          harness,
        )
      }
      return existing
    }

    const pending = this.creationLocks.get(serverId)
    if (pending) {
      if (pending.harness !== harness) {
        throw new AcpHarnessConflictError(
          serverId,
          pending.harness,
          harness,
        )
      }
      return pending.promise
    }

    const creation = this.create(serverId, harness)
    this.creationLocks.set(serverId, {
      harness,
      promise: creation,
    })
    try {
      return await creation
    } finally {
      this.creationLocks.delete(serverId)
    }
  }

  private async create(
    serverId: string,
    harness: AcpHarnessId,
  ): Promise<AcpRuntimeProcess> {
    const descriptor = this.options.registry.get(harness)
    if (!descriptor) {
      throw new Error(`unsupported ACP agent '${harness}'`)
    }
    const baseEnv = this.options.baseEnv ?? process.env
    const merged = this.options.projectEnv
      ? mergeProjectEnv(baseEnv, this.options.projectEnv)
      : baseEnv
    // The OpenCode harness is the same binary the supervisor spawns for the
    // legacy REST transport, so it needs that path's managed launch env — the
    // synthetic `kortix` gateway provider above all. Without it OpenCode knows
    // no `kortix/*` model and rejects every managed model the picker offers.
    const env =
      harness === 'opencode'
        ? await resolveManagedOpencodeLaunchEnv(merged, {
            configPath: this.options.opencodeConfigPath,
          })
        : merged
    const instance = new AcpRuntimeProcess(
      serverId,
      descriptor,
      {
        cwd: this.options.cwd,
        env,
        requestTimeoutMs: this.options.requestTimeoutMs,
        initializeOnStart: this.options.initializeOnCreate,
        onStartupMark: this.options.onStartupMark,
        onUnexpectedExit: (exited) => {
          if (this.instances.get(serverId) === exited) {
            this.instances.delete(serverId)
          }
        },
      },
    )
    try {
      await instance.waitUntilStarted()
    } catch (error) {
      await instance.stop()
      throw new AcpUpstreamError(
        error instanceof Error ? error.message : String(error),
      )
    }
    this.instances.set(serverId, instance)
    return instance
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
    await Promise.all(
      instances.map((instance) => instance.stop()),
    )
  }
}

export class AcpHarnessConflictError extends Error {
  constructor(
    readonly serverId: string,
    readonly existingHarness: AcpHarnessId,
    readonly requestedHarness: AcpHarnessId,
  ) {
    super(
      `ACP server '${serverId}' already uses ` +
        `'${existingHarness}', not '${requestedHarness}'`,
    )
  }
}

export class AcpUpstreamError extends Error {}
