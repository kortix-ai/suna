/**
 * `/kortix/health`, `/kortix/diag` and `/kortix/logs` for a pi session.
 *
 * The health shape keeps every field the control plane reads for OpenCode:
 * `opencode` carries the runtime state (the API's readiness readers key on
 * `opencode === 'ok'`), `opencode_session_id` the root. `harness: 'pi'`
 * names what is actually answering.
 */
import type { HarnessDiagnosticsContext, HarnessDiagnosticsService, HarnessHealthReport } from '../contract/diagnostics'
import { readHostHealth } from '../shared/host-health'
import { daemonLogFilePath } from '@/lib/log/logger'
import { tailFile } from '@/lib/log/log-tail'
import { runtimeConvergenceReport } from '@/services/runtime-assets/runtime-assets'
import type { PiBootState } from './boot-state'
import type { PiRuntime } from './runtime'

// `startError` reads the runtime even before start() resolves: `runtime()` is
// null until then, and a failed start must still surface as boot_error.
export function createPiDiagnosticsService(runtime: () => PiRuntime | null, startError: () => string | null): HarnessDiagnosticsService {
  return {
    async health(context, query): Promise<HarnessHealthReport> {
      const bootState: PiBootState = context.bootState
      const host = await readHostHealth(context)
      const rt = runtime()
      const state = rt?.getState() ?? 'down'
      const initialSessionReady = !bootState.initialOpenCodeSessionRequired || !!bootState.initialOpenCodeSessionId
      const initialSessionError = bootState.initialOpenCodeSessionError ?? null
      const startFailure = startError()
      const runtimeReady = host.repo_ready && !bootState.repoMaterializationError && !initialSessionError && !startFailure && state === 'ok' && initialSessionReady
      const status = runtimeReady ? 'ok' : bootState.repoMaterializationError || initialSessionError || startFailure ? 'error' : state
      const probe = query.turn !== undefined && rt ? rt.turnProbe(query.turn.messageId || null) : null
      return {
        ...host,
        daemon: 'ok',
        status,
        runtimeReady,
        opencode: state,
        opencode_pid: null,
        opencode_port: null,
        compiled_runtime: false,
        compiled_runtime_format: null,
        compiled_runtime_source_sha: null,
        model: rt?.selectedModel() ? `${rt.selectedModel()!.providerID}/${rt.selectedModel()!.modelID}` : null,
        // Which pi extensions loaded, and why any package did not (not installed, load error).
        extensions: rt?.extensionStatus() ?? null,
        ...(probe ? { turn_in_flight: probe.inFlight, turn_end: probe.end, turn_orphaned_prompt: probe.orphanedPrompt } : {}),
        boot_error: bootState.repoMaterializationError ?? initialSessionError ?? startFailure,
        opencode_session_id: bootState.initialOpenCodeSessionId ?? null,
        opencode_session_required: !!bootState.initialOpenCodeSessionRequired,
      }
    },
    async report(context, tail) {
      const { cfg } = context
      const bootState: PiBootState = context.bootState
      const monitor = context.resources()
      const rt = runtime()
      const [resources, convergence] = await Promise.all([
        monitor ? monitor.tick('diag').catch(() => null) : Promise.resolve(null),
        runtimeConvergenceReport().catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
      ])
      const daemonLog = daemonLogFilePath()
      return {
        at: new Date().toISOString(),
        daemon: {
          pid: process.pid,
          bun: typeof Bun !== 'undefined' ? Bun.version : null,
          uptime_s: Math.floor((Date.now() - context.bootTime) / 1000),
          workspace: cfg.workspace,
          service_port: cfg.servicePort,
          daemon_log_file: daemonLog,
        },
        pi: {
          state: rt?.getState() ?? 'down',
          root_id: rt?.rootId ?? null,
          model: rt?.selectedModel() ? `${rt.selectedModel()!.providerID}/${rt.selectedModel()!.modelID}` : null,
          agent: rt?.agentNameValue() ?? null,
          busy: rt?.busy() ?? false,
          messages: rt?.transcript.count ?? 0,
          skills: rt?.skillList().length ?? 0,
          start_error: startError(),
        },
        boot: {
          repo_materialization_error: bootState.repoMaterializationError,
          initial_session_error: bootState.initialOpenCodeSessionError ?? null,
          timeline: bootState.timeline,
        },
        resources,
        resources_previous: monitor?.latest() ?? null,
        runtime: convergence,
        logs: { tail, daemon: daemonLog ? tailFile(daemonLog, tail) : null },
      }
    },
    logSources: () => ['daemon'],
    readLog(source, lines) {
      if (source !== 'daemon') throw new Error(`Unknown log source: ${source}`)
      const path = daemonLogFilePath()
      return { label: path ?? '(daemon file sink disabled: KORTIX_DAEMON_LOG_FILE=off)', text: path ? tailFile(path, lines) : null }
    },
  }
}
