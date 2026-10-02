/**
 * `/kortix/health`, `/kortix/diag` and `/kortix/logs` for a pi session.
 *
 * Health is pi's closed `harness` block; `routes/kortix/health.ts` adds the
 * host facts, the pre-W3 flat fields the API still reads, and `runtimeReady`.
 */
import type { HarnessDiagnosticsService, HarnessHealthReport } from '../contract/diagnostics'
import { daemonLogFilePath } from '@/lib/log/logger'
import { tailFile } from '@/lib/log/log-tail'
import { runtimeConvergenceReport } from '@/services/runtime-assets/runtime-assets'
import type { PiBootState } from './boot-state'
import type { PiConfigReleases } from './config-release'
import type { PiRuntime } from './runtime'
import { PI_HARNESS_VERSION } from './version'

// `startError` reads the runtime even before start() resolves: `runtime()` is
// null until then, and a failed start must still surface as boot_error.
export function createPiDiagnosticsService(
  runtime: () => PiRuntime | null,
  startError: () => string | null,
  releases: Pick<PiConfigReleases, 'report' | 'sourceCommit'>,
): HarnessDiagnosticsService {
  return {
    // Subagents (the `task` tool) and compaction are native; rewind, commands,
    // fork, MCP, todo, shell and the harness's own terminal client are not yet
    // (pi/surface.ts answers them 501 `feature_not_supported`).
    capabilities: ['session.subagents', 'session.compact'],
    async health(context, query): Promise<HarnessHealthReport> {
      const bootState: PiBootState = context.bootState
      const rt = runtime()
      const state = rt?.getState() ?? 'down'
      const initialSessionReady = !bootState.initialRuntimeSessionRequired || !!bootState.initialRuntimeSessionId
      const error = bootState.initialRuntimeSessionError ?? startError() ?? bootState.auditRelayError ?? null
      const probe = query.turn !== undefined && rt ? rt.turnProbe(query.turn.messageId || null) : null
      const model = rt?.selectedModel()
      // The same read the `config` block reports, so `ready` never disagrees with it.
      const config = releases.report()
      return {
        harness: {
          id: 'pi',
          version: PI_HARNESS_VERSION,
          state,
          ready: !error && state === 'ok' && config.proven && initialSessionReady,
          error,
          session: { id: bootState.initialRuntimeSessionId ?? null, required: !!bootState.initialRuntimeSessionRequired },
          turn: probe ? { in_flight: probe.inFlight, end: probe.end, orphaned_prompt: probe.orphanedPrompt } : null,
          details: {
            model: model ? `${model.providerID}/${model.modelID}` : null,
            // Which pi extensions loaded, and why any package did not (not installed, load error).
            extensions: rt?.extensionStatus() ?? null,
          },
        },
        config,
        // The running release's source commit, for API readers that predate `config`.
        configDirSha: releases.sourceCommit(),
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
          initial_session_error: bootState.initialRuntimeSessionError ?? null,
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
