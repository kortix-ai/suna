import type { Config } from '../config'
import type { SandboxBootState } from '../boot-state'
import type { ResourceMonitor } from '../resources'

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

/** Native diagnostic fields remain available without exposing implementation types. */
export interface HarnessHealthReport {
  daemon: 'ok'
  status: 'ok' | 'starting' | 'down' | 'error'
  runtimeReady: boolean
  uptime_s: number
  [field: string]: unknown
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
  health(context: HarnessDiagnosticsContext, query: HarnessHealthQuery): Promise<HarnessHealthReport>
  report(context: HarnessDiagnosticsContext, tail: number): Promise<HarnessDiagnosticReport>
  logSources(): readonly string[]
  readLog(source: string, lines: number): HarnessLogTail
}
