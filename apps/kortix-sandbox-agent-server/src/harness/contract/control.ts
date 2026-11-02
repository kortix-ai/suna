import type { Config } from '@/lib/config/config'
import type { RepoInfo } from '@/lib/git/git'
import type { ProjectEnvStore } from '@/services/sandbox-env/project-env'

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

/**
 * Response of `POST /kortix/env`. `runtime*` describes the session runtime.
 */
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
  runtime_env_changed: boolean
  runtime_env_names: string[]
  runtime: string
  runtime_pid: number | null
  runtime_reload: 'disposed' | 'restarted' | 'kept-old' | null
  runtime_turn_ended: boolean | null
}

export interface HarnessRefreshInput {
  /** Leave the checkout exactly as it is — no pull of the session branch. */
  skipRepo?: boolean
}

export interface HarnessRefreshResult {
  ok: true
  repo: { before: RepoInfo; after: RepoInfo }
  runtime: string
  runtime_pid: number | null
}

export type HarnessAbortResult =
  | { outcome: 'aborted'; body: { ok: true; runtime_session_id: string } }
  | { outcome: 'not-pinned'; body: { ok: false; error: string } }
  | { outcome: 'failed'; body: { ok: false; error: string; detail?: string } }

/** A queued prompt that interrupts the named turn after its running tool ends. */
export interface HarnessAbortAfterToolInput {
  promptId: string
  runtimeSessionId: string
  messageId: string
}

/** The health `config` block. */
export interface HarnessConfigReleaseReport {
  release_id: string | null
  desired_release_id: string | null
  /**
   * `workspace` only when the box has no Kortix API to ask, or an API from
   * before config releases graduated answered `403 feature_disabled`.
   */
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
 * boundary lint in eslint.config.mjs, see ARCHITECTURE.md).
 */
export const MAX_SWAP_DELAY_MS = 30_000

/** Test-only inputs on the convergence. See `ConvergeDeps.delayBeforeSwapMs`. */
export interface HarnessConfigConvergeOptions {
  delayBeforeSwapMs?: number
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
  /**
   * Is a config convergence in flight RIGHT NOW — fetch, download, verify,
   * swap?
   *
   * DEF-B 2026-09-26: `app/server.ts` registers this as a swap blocker
   * (`registerAgentSwapBlocker('config-convergence', ...)`) so a staged
   * daemon update never exits mid-convergence. The convergence runs inside
   * this process, so the exit cuts it off part-way, before the release could
   * prove itself.
   *
   * Lives on the CONTRACT, not called through an adapter import from
   * `app/server.ts`: the harness ownership boundary (eslint.config.mjs,
   * ARCHITECTURE.md) forbids host production code from
   * importing a concrete adapter directly. Absent, or answering `false`
   * unconditionally, on a runtime without a config-convergence concept — it
   * never blocks there, which is correct: nothing is mid-verify on a runtime
   * that never verifies one.
   */
  convergenceInFlight?(): boolean
}
