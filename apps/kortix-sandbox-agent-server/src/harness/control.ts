import type { Config } from '../config'
import type { ConfigDirSyncResult, RepoInfo } from '../git'
import type { ProjectEnvStore } from '../project-env'

/** HTTP-independent control input. Native environment names remain adapter-owned. */
export interface HarnessEnvironmentInput {
  revision: string
  env: Record<string, unknown>
  names?: unknown
  refreshModels?: unknown
  runtimeEnv?: unknown
  llmGatewayEnabled?: unknown
  llmGatewayBaseUrl?: unknown
}

/** Existing response keys are compatibility fields, not native implementation types. */
export interface HarnessEnvironmentResult {
  ok: true
  changed: boolean
  revision: string
  names: string[]
  exported: number
  managed: number
  withheld: number
  agent_env_written: boolean
  egress_shim: 'unchanged' | 'started' | 'restarted' | 'stopped' | 'failed'
  egress_shim_hosts: readonly string[]
  opencode_env_changed: boolean
  opencode_env_names: string[]
  opencode: string
  opencode_pid: number | null
  opencode_reload: 'disposed' | 'restarted' | 'kept-old' | null
  opencode_turn_ended: boolean | null
}

export interface HarnessRefreshInput {
  syncBase: boolean
  skipRestart: boolean
  syncConfigDir: boolean
  /** Respawn the runtime when, and only when, the directory it reads changed. */
  reloadIfSynced?: boolean
  /** Leave the checkout exactly as it is — no pull of the session branch. */
  skipRepo?: boolean
  baseSha?: string
  forceFail: boolean
}

export interface HarnessRefreshResult {
  ok: true
  repo: { before: RepoInfo; after: RepoInfo }
  config_dir?: ConfigDirSyncResult
  /** Present when the runtime was respawned because the directory it reads changed. */
  config_dir_reload?: { how: 'restarted' | 'kept-old'; turn_ended: boolean | null }
  reload?: {
    outcome: 'swapped' | 'kept-old'
    port?: number
    pid?: number | null
    turn_ended?: boolean | null
    reason?: string
  }
  opencode: string
  opencode_pid: number | null
}

export type HarnessAbortResult =
  | { outcome: 'aborted'; body: { ok: true; opencode_session_id: string } }
  | { outcome: 'not-pinned'; body: { ok: false; error: string } }
  | { outcome: 'failed'; body: { ok: false; error: string; detail?: string } }

/** A queued prompt that interrupts the named turn after its running tool ends. */
export interface HarnessAbortAfterToolInput {
  promptId: string
  opencodeSessionId: string
  messageId: string
}

export interface HarnessControlOperations {
  applyEnvironment(input: HarnessEnvironmentInput): Promise<HarnessEnvironmentResult>
  refresh(input: HarnessRefreshInput): Promise<HarnessRefreshResult>
  abort(): Promise<HarnessAbortResult>
  armAbortAfterTool(input: HarnessAbortAfterToolInput): Promise<void>
  /** Without a prompt id, disarm every pending interrupt. */
  disarmAbortAfterTool(promptId?: string): void
}

export interface HarnessControlContext {
  cfg: Config
  projectEnv?: ProjectEnvStore
  agentEnvFile?: string
}

export interface HarnessControlService {
  /** Bind the current app's configuration; rebuild this view on warm adoption. */
  bind(context: HarnessControlContext): HarnessControlOperations
}
