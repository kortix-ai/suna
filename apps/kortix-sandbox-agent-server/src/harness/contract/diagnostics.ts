import type { HarnessHealth, RuntimeCapability } from '@kortix/api-contract/runtime-relay'
import type { Config } from '@/lib/config/config'
import type { SandboxBootState } from './boot-state'
import type { HarnessConfigReleaseReport } from './control'
import type { ResourceMonitor } from '@/services/resources/resources'

/** Supplied per invocation so warm adoption uses the current host configuration. */
export interface HarnessDiagnosticsContext {
  cfg: Config
  bootTime: number
  bootState: SandboxBootState
  staticWebPort: number | null
  resources: () => ResourceMonitor | null
}

export interface HarnessHealthQuery {
  /** Absence leaves the potentially expensive turn observation disabled. */
  turn?: { sessionId?: string; messageId?: string }
}

/** A harness's live model-catalog signal for the health `runtime` block (see `runtimeConvergenceReport`). */
export type CatalogSnapshot = () => { ids: string[] | null; fallbackReason: string | null }

/**
 * What the selected harness reports on `GET /kortix/health`.
 * `routes/kortix/health.ts` composes it with the host facts and computes
 * `runtimeReady` from both.
 */
export interface HarnessHealthReport {
  /** The closed harness block. `version` null lets the route read the runtime-assets record. */
  harness: HarnessHealth
  /** The `config` block (`config.release.v1`); absent on a runtime without config releases. */
  config?: HarnessConfigReleaseReport
  /** The running release's source commit, for API readers that predate `config`. */
  configDirSha?: string | null
}

export interface HarnessDiagnosticReport {
  at: string
  daemon: {
    pid: number
    bun: string | null
    uptime_s: number
    workspace: string
    service_port: number
    daemon_log_file: string | null
  }
  boot: {
    repo_materialization_error: string | null
    initial_session_error: string | null
    timeline: SandboxBootState['timeline']
  }
  resources: unknown
  resources_previous: unknown
  runtime: unknown
  logs: { tail: number; [source: string]: string | number | null }
  [field: string]: unknown
}

export interface HarnessLogTail {
  label: string
  text: string | null
}

/** Data operations only. Controllers own authentication and HTTP representation. */
export interface HarnessDiagnosticsService {
  /**
   * The session features this runtime serves, listed in health `capabilities`
   * (E1). A client hides the control of a feature that is absent.
   */
  readonly capabilities: readonly RuntimeCapability[]
  /** The live model-catalog signal, for a harness that has one. */
  readonly catalogSnapshot?: CatalogSnapshot
  health(context: HarnessDiagnosticsContext, query: HarnessHealthQuery): Promise<HarnessHealthReport>
  report(context: HarnessDiagnosticsContext, tail: number): Promise<HarnessDiagnosticReport>
  logSources(): readonly string[]
  readLog(source: string, lines: number): HarnessLogTail
}
