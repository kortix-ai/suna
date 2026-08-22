import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { NodeAssignmentSpec, NodeChannelFrame } from '@kortix/api-contract/node-channel'
import { nodeStateDirectory } from './config-store'

interface PersistedAssignment {
  assignment: NodeAssignmentSpec
  state: 'starting' | 'ready' | 'stopped'
  updated_at: string
}

interface AssignmentProcess {
  readonly pid?: number
  readonly exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface AssignmentManagerOptions {
  stateDirectory?: string
  executable?: string
  spawnProcess?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => AssignmentProcess
  checkReady?: (port: number, signal: AbortSignal) => Promise<{ ready: boolean; nativeConversationId?: string }>
  now?: () => Date
  onFrame(frame: NodeChannelFrame): void
}

const READY_TIMEOUT_MS = 120_000

function assignmentStatePath(directory: string): string { return join(directory, 'assignment.json') }

function safeWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function defaultSpawn(executable: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(executable, args, { env, stdio: 'ignore' })
}

async function defaultReady(port: number, signal: AbortSignal) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/kortix/health`, { signal })
    if (!response.ok) return { ready: false }
    const body = await response.json().catch(() => null) as { runtimeReady?: boolean; opencodeSessionId?: string } | null
    return { ready: body?.runtimeReady === true, nativeConversationId: body?.opencodeSessionId }
  } catch { return { ready: false } }
}

export class NodeAssignmentManager {
  private readonly directory: string
  private readonly executable: string
  private readonly now: () => Date
  private child: AssignmentProcess | null = null
  private current: PersistedAssignment | null = null
  private readyAbort: AbortController | null = null
  private readonly sendSequences = new Map<string, number>()

  constructor(private readonly options: AssignmentManagerOptions) {
    this.directory = options.stateDirectory ?? nodeStateDirectory()
    this.executable = options.executable ?? process.execPath
    this.now = options.now ?? (() => new Date())
    this.current = this.readPersisted()
  }

  get assignment(): NodeAssignmentSpec | null { return this.current?.assignment ?? null }
  get writableRoots(): readonly string[] {
    const assignment = this.current?.assignment
    return assignment ? [join(this.directory, 'workspaces', assignment.session_id), ...assignment.writable_roots] : []
  }
  hasPort(port: number): boolean { return this.current?.state === 'ready' && this.current.assignment.ports.includes(port) }
  isBusy(): boolean { return Boolean(this.child && this.child.exitCode === null) }
  resetSequences(): void { this.sendSequences.clear() }

  async handle(frame: NodeChannelFrame): Promise<boolean> {
    if (frame.type === 'assignment.apply') {
      await this.apply(frame)
      return true
    }
    if (frame.type === 'assignment.stop') {
      await this.stop(frame.stream_id, frame.seq, frame.reason)
      return true
    }
    return false
  }

  async restore(): Promise<void> {
    if (!this.current || this.current.state === 'stopped') return
    if (new Date(this.current.assignment.lease_expires_at) <= this.now()) {
      this.clearState(false)
      return
    }
    await this.start(this.current.assignment, 0)
  }

  private async apply(frame: Extract<NodeChannelFrame, { type: 'assignment.apply' }>): Promise<void> {
    const assignment = frame.assignment
    const expiresAt = new Date(assignment.lease_expires_at)
    if (expiresAt <= this.now()) return this.reject(frame, 'Assignment lease is expired')
    if (assignment.assignment_id !== frame.stream_id) return this.reject(frame, 'Assignment identity does not match stream identity')
    if (assignment.env.KORTIX_SESSION_ID && assignment.env.KORTIX_SESSION_ID !== assignment.session_id) return this.reject(frame, 'Session identity mismatch')
    if (assignment.env.KORTIX_PROJECT_ID && assignment.env.KORTIX_PROJECT_ID !== assignment.project_id) return this.reject(frame, 'Project identity mismatch')

    const current = this.current?.assignment
    if (current) {
      if (current.assignment_id === assignment.assignment_id && current.lease_epoch === assignment.lease_epoch) {
        this.emit({ v: 1, type: 'assignment.accept', stream_id: frame.stream_id, seq: 0, status: this.current!.state === 'ready' ? 'ready' : 'starting' })
        if (!this.child && this.current!.state !== 'stopped') await this.start(assignment, frame.seq + 1)
        return
      }
      if (current.session_id === assignment.session_id && assignment.lease_epoch <= current.lease_epoch) return this.reject(frame, 'Assignment lease epoch is stale')
      if (this.child && this.child.exitCode === null) return this.reject(frame, 'Compute node already has an active assignment')
    }

    this.current = { assignment, state: 'starting', updated_at: this.now().toISOString() }
    this.persist()
    this.emit({ v: 1, type: 'assignment.accept', stream_id: frame.stream_id, seq: 0, status: 'starting' })
    await this.start(assignment, frame.seq + 1)
  }

  private async start(assignment: NodeAssignmentSpec, responseSeq: number): Promise<void> {
    const workspace = join(this.directory, 'workspaces', assignment.session_id)
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const env: NodeJS.ProcessEnv = { ...process.env, ...assignment.env }
    delete env.KORTIX_NODE_TOKEN
    delete env.KORTIX_SANDBOX_TOKEN
    delete env.KORTIX_TOKEN
    env.KORTIXD_ASSIGNED_CHILD = '1'
    env.KORTIX_SESSION_ID = assignment.session_id
    env.KORTIX_PROJECT_ID = assignment.project_id
    env.KORTIX_REPO_URL = assignment.repository.url
    env.KORTIX_BRANCH_NAME = assignment.repository.branch
    env.KORTIX_DEFAULT_BRANCH = assignment.repository.base_ref
    env.KORTIX_WORKSPACE = workspace
    env.KORTIX_PROJECT_TARGET = workspace
    env.KORTIX_PROJECT_SECRETS_REVISION = assignment.secrets_revision
    env.KORTIX_SERVICE_PORT = String(assignment.ports[0] ?? 8000)
    env.KORTIXD_HOME = join(workspace, '.kortixd-runtime')
    mkdirSync(env.KORTIXD_HOME, { recursive: true, mode: 0o700 })
    const child = (this.options.spawnProcess ?? defaultSpawn)(this.executable, ['run'], env)
    this.child = child
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.readyAbort?.abort()
      if (this.current?.assignment.assignment_id === assignment.assignment_id && this.current.state !== 'stopped') {
        this.current.state = 'stopped'
        this.current.updated_at = this.now().toISOString()
        this.persist()
        this.emit({ v: 1, type: 'assignment.stopped', stream_id: assignment.assignment_id, seq: 0, reason: 'workload process exited' })
      }
    })
    void this.waitReady(assignment, responseSeq)
  }

  private async waitReady(assignment: NodeAssignmentSpec, responseSeq: number): Promise<void> {
    this.readyAbort?.abort()
    const controller = new AbortController()
    this.readyAbort = controller
    const deadline = Date.now() + READY_TIMEOUT_MS
    const port = assignment.ports[0] ?? 8000
    while (!controller.signal.aborted && Date.now() < deadline && this.child?.exitCode === null) {
      const result = await (this.options.checkReady ?? defaultReady)(port, controller.signal)
      if (result.ready) {
        if (!this.current || this.current.assignment.assignment_id !== assignment.assignment_id) return
        this.current.state = 'ready'
        this.current.updated_at = this.now().toISOString()
        this.persist()
        this.emit({ v: 1, type: 'assignment.ready', stream_id: assignment.assignment_id, seq: 0, ports: assignment.ports, ...(result.nativeConversationId ? { native_conversation_id: result.nativeConversationId } : {}) })
        return
      }
      await Bun.sleep(500)
    }
    if (!controller.signal.aborted && this.child?.exitCode === null) this.child.kill('SIGTERM')
  }

  private async stop(streamId: string, seq: number, reason: 'stop' | 'restart' | 'release' | 'drain'): Promise<void> {
    if (!this.current || this.current.assignment.assignment_id !== streamId) {
      this.emit({ v: 1, type: 'assignment.stopped', stream_id: streamId, seq: 0, reason: 'assignment is not active' })
      return
    }
    this.readyAbort?.abort()
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill('SIGTERM')
    this.current.state = 'stopped'
    this.current.updated_at = this.now().toISOString()
    this.persist()
    if (reason === 'release') this.clearState(true)
    this.emit({ v: 1, type: 'assignment.stopped', stream_id: streamId, seq: 0, reason })
  }

  private reject(frame: { stream_id: string; seq: number }, reason: string): void {
    this.emit({ v: 1, type: 'assignment.reject', stream_id: frame.stream_id, seq: 0, reason })
  }

  private emit(frame: NodeChannelFrame): void {
    const seq = this.sendSequences.get(frame.stream_id) ?? 0
    this.sendSequences.set(frame.stream_id, seq + 1)
    frame.seq = seq
    this.options.onFrame(frame)
  }

  private persist(): void { if (this.current) safeWrite(assignmentStatePath(this.directory), this.current) }

  private readPersisted(): PersistedAssignment | null {
    const path = assignmentStatePath(this.directory)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) as PersistedAssignment } catch { return null }
  }

  private clearState(removeWorkspace: boolean): void {
    const assignment = this.current?.assignment
    if (removeWorkspace && assignment) rmSync(join(this.directory, 'workspaces', assignment.session_id), { recursive: true, force: true })
    rmSync(assignmentStatePath(this.directory), { force: true })
    this.current = null
  }
}
