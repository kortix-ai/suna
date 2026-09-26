import type { Config } from '../config'
import type { RepoInfo } from '../git'
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
  /** Leave the checkout exactly as it is — no pull of the session branch. */
  skipRepo?: boolean
  baseSha?: string
  forceFail: boolean
}

export interface HarnessRefreshResult {
  ok: true
  repo: { before: RepoInfo; after: RepoInfo }
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

/** The health `config` block. Spec: docs/specs/config-releases.md, "Health". */
export interface HarnessConfigReleaseReport {
  release_id: string | null
  desired_release_id: string | null
  /** `workspace` only while `config_releases` is off for the project. */
  source: 'release' | 'workspace' | 'image-default'
  /** Null before the first convergence; `follow-base` is the only mode. */
  mode: 'follow-base' | null
  proven: boolean
  fallback_reason: string | null
  failed_release_id: string | null
}

/** Response of `POST /kortix/config/converge`. */
export interface HarnessConfigConvergeResult {
  ok: boolean
  outcome: 'applied' | 'unchanged' | 'declined' | 'quarantined' | 'failed'
  config: HarnessConfigReleaseReport
  reload: { how: 'restarted'; turn_ended: boolean | null } | null
  reason: string | null
}

/**
 * The longest a fault-injected delay may hold a convergence.
 *
 * It lives on the harness CONTRACT, not inside an adapter, because the route
 * that parses the query parameter may not import an adapter (the ownership
 * boundary tripwire in `__tests__/harness-boundary.test.ts`).
 */
export const MAX_SWAP_DELAY_MS = 30_000

/** Test-only inputs on the convergence. See `ConvergeDeps.delayBeforeSwapMs`. */
export interface HarnessConfigConvergeOptions {
  delayBeforeSwapMs?: number
}

/** Response of `POST /kortix/catalog/converge`. See `convergeManagedModelCatalog`. */
export interface HarnessCatalogConvergeResult {
  /** false only for `outcome: 'no-gateway'` — every other outcome is a real
   *  answer, including 'declined', which the caller must still read the reason
   *  of rather than treat as a failure. */
  ok: boolean
  outcome: 'unchanged' | 'file-updated' | 'restarted' | 'declined' | 'no-gateway'
  /** Managed ids the live gateway serves that this box's booted config lacked,
   *  as of the fresh fetch this call made. */
  missing: string[]
  managed: number
  reason: string | null
}

export interface HarnessControlOperations {
  applyEnvironment(input: HarnessEnvironmentInput): Promise<HarnessEnvironmentResult>
  refresh(input: HarnessRefreshInput): Promise<HarnessRefreshResult>
  /**
   * Fetch the desired config release from the API and apply it. Absent on a
   * runtime without config releases. Throws an error named
   * `ConvergeBusyError` while another convergence runs.
   */
  convergeConfig?(options?: HarnessConfigConvergeOptions): Promise<HarnessConfigConvergeResult>
  /**
   * Fetch the live managed-model lineup and repair the box's provider map if
   * it is missing something the lineup serves — one verified OpenCode restart
   * when idle, never across a running turn. Absent on a runtime that has no
   * gateway-model concept (pi). See `convergeManagedModelCatalog`.
   */
  convergeCatalog?(): Promise<HarnessCatalogConvergeResult>
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
