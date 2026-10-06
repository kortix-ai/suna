import { join } from 'node:path'
import type {
  HarnessDiagnosticsContext,
  HarnessDiagnosticsService,
  HarnessDiagnosticReport,
  HarnessHealthQuery,
  HarnessHealthReport,
} from '../contract/diagnostics'
import { requireOpenCodeConfig } from './config'
import { OPENCODE_HOME } from './paths'
import { projectOpenCodeResourceSnapshot } from './resource-diagnostics'
import { RUNTIME_CAPABILITIES } from '@kortix/api-contract/runtime-relay'
import { daemonLogFilePath } from '@/lib/log/logger'
import { tailFile } from '@/lib/log/log-tail'

import { configReleaseReport, runningSourceCommit } from './config-release'
import { runtimeConvergenceReport } from '@/services/runtime-assets/runtime-assets'
import { tickIntervalMs as runtimeTruthTickIntervalMs } from '@/services/runtime-assets/runtime-truth'
import { managedCatalogFallbackReason, managedModelIdsSnapshot, type Opencode } from './lifecycle'
import {
  type OpencodeDeliveryObservation,
  inspectOpencodeRoot,
  observeOpencodeDelivery,
  opencodeSessionInFlight,
} from './opencode-turn-state'
import { readOpenCodeSessionPin } from './runtime-state'

import type { OpenCodeBootState } from './boot-state'

export function opencodeLogFilePath(home: string): string {
  return join(home, '.local', 'share', 'opencode', 'log', 'opencode.log')
}

/** The live catalog signal `runtimeConvergenceReport` overlays onto
 *  `runtime.running` — see `RunningRuntimeAssets.managed_model_ids` for what
 *  the control plane does with it. */
function catalogSnapshotForHealth(): { ids: string[] | null; fallbackReason: string | null } {
  return { ids: managedModelIdsSnapshot(), fallbackReason: managedCatalogFallbackReason() }
}

/**
 * Answer `?turn=1` for the identity the caller asked about.
 *
 * Only the message-scoped read can attribute an ending to ONE turn. The
 * root-scoped fallback (older daemons' callers, command turns with no message
 * id) answers about the whole root, so it names no reason rather than lend one
 * turn's outcome to another.
 */
export async function observeRequestedTurn(
  opencodeUrl: string,
  workspace: string,
  identity: { sessionId: string | null; messageId: string | null },
): Promise<OpencodeDeliveryObservation> {
  if (identity.sessionId && identity.messageId) {
    return observeOpencodeDelivery(opencodeUrl, workspace, identity.sessionId, identity.messageId)
  }
  const sessionId = identity.sessionId ?? ''
  const inspection = await inspectOpencodeRoot(opencodeUrl, workspace, sessionId)
  if (!inspection.known) return { inFlight: null, end: null }
  if (inspection.turnInFlight)
    return { inFlight: true, end: null, orphanedPrompt: inspection.orphanedPrompt }

  // The transcript reads terminal — ASK OpenCode before saying so. `abandoned`
  // routes straight into the inbox's redelivery, and the window between "the
  // prompt is persisted" and "its assistant message exists" is a normal part of
  // a LIVE delivery: a root-scoped read taken inside that window sees a prompt
  // with no answer and used to call it abandoned, re-sending a prompt that was
  // already executing. `/session/status` closes the window.
  const busy = await opencodeSessionInFlight(opencodeUrl, workspace, sessionId)
  if (busy === null) return { inFlight: null, end: null }
  if (busy) return { inFlight: true, end: null, orphanedPrompt: inspection.orphanedPrompt }
  return {
    inFlight: false,
    // The ONE ending a root-scoped read can prove without lending another
    // turn's outcome to this one: the root's newest prompt has no assistant
    // message answering it. `abandoned` is already in the control plane's
    // DAEMON_REPORTABLE_END_REASONS, and it is what triggers redelivery.
    end: inspection.orphanedPrompt ? 'abandoned' : null,
    orphanedPrompt: inspection.orphanedPrompt,
  }
}

export function resolveTurnObservationIdentity(
  requestedSession: string | undefined,
  requestedMessage: string | undefined,
  pinnedSession: string | null,
): { sessionId: string | null; messageId: string | null } {
  return {
    sessionId: requestedSession || pinnedSession,
    messageId: requestedMessage || null,
  }
}

/**
 * OpenCode's health block. `routes/kortix/health.ts` adds the host facts and
 * computes `runtimeReady`.
 */
async function readOpenCodeHealth(
  context: HarnessDiagnosticsContext,
  opencode: Opencode,
  query: HarnessHealthQuery,
): Promise<HarnessHealthReport> {
  const bootState: OpenCodeBootState = context.bootState
  const opencodeState = opencode.getState()
  const initialSessionReady =
    !bootState.initialRuntimeSessionRequired || !!bootState.initialRuntimeSessionId
  const error = bootState.initialRuntimeSessionError ?? bootState.auditRelayError ?? null
  // PLAN-one-boot-path C3: a box is never reportable as ready unless it runs a
  // PROVEN config. `opencodeState === 'ok'` is not that proof — its liveness
  // probe only asks whether the session API answers, so a config whose tools or
  // plugins never registered still reads as 'ok'. The proof
  // (`proven-check.ts`) is what checked them, and the boot path writes its
  // verdict here before it opens the gate. Off the release path (config
  // releases disabled) the boot path states `proven: true` for the checkout it
  // pointed OpenCode at, so this term is inert there.
  //
  // The SAME read the `config` block reports, so no health sample can show
  // `runtimeReady: true` beside a `config` block that disagrees.
  const configReport = configReleaseReport()
  const configProven = configReport.proven
  // The harness half of `runtimeReady`; the route adds the host's workspace checks.
  const runtimeReady = !error && opencodeState === 'ok' && configProven && initialSessionReady

  // Opt-in (`?turn=1`) because it costs a call into opencode, and health is
  // polled as a liveness check every few seconds on every idle box. Two
  // callers ask: the reload gate, which must not restart the runtime out from
  // under a running turn, and the control plane's reaper, which repairs turn
  // authority a lost relay left behind.
  const turn =
    query.turn !== undefined
      ? await observeRequestedTurn(
          opencode.getInternalUrl(),
          process.env.KORTIX_WORKSPACE || '/workspace',
          resolveTurnObservationIdentity(query.turn.sessionId, query.turn.messageId, readOpenCodeSessionPin()),
        )
      : undefined

  return {
    harness: {
      id: 'opencode',
      // The runtime-assets record states the OpenCode release on disk.
      version: null,
      state: opencodeState,
      ready: runtimeReady,
      error,
      session: {
        id: bootState.initialRuntimeSessionId ?? null,
        required: !!bootState.initialRuntimeSessionRequired,
      },
      turn: turn
        ? {
            in_flight: turn.inFlight,
            // WHY it is not in flight, when the message list proves it:
            // 'completed' | 'failed' | 'abandoned', else null. The control
            // plane writes this straight into session_turns.end_reason.
            end: turn.end,
            // "A prompt is on record with nothing answering it": evidence about
            // the PROMPT, which the control plane redelivers on.
            orphaned_prompt: turn.orphanedPrompt ?? false,
          }
        : null,
      details: {
        pid: opencode.getPid(),
        // The port opencode listens on right now. It ALTERNATES: a verified
        // reload boots the replacement on the idle half of the port pair. The
        // API's PTY proxy reaches opencode directly (the daemon cannot carry a
        // WebSocket), so it must not assume 4096.
        port: opencode.getActivePort(),
        // How often the periodic reconcile floor runs, so "why hasn't this
        // healed yet" has an answer bound to a number.
        runtime_truth_tick_interval_ms: runtimeTruthTickIntervalMs(),
      },
    },
    config: configReport,
    // The running release's source commit, for API readers that predate
    // `config`; null off the release path.
    configDirSha: runningSourceCommit(),
  }
}

async function readOpenCodeDiagnosticReport(
  opencode: Opencode,
  home: string,
  context: HarnessDiagnosticsContext,
  tail: number,
): Promise<HarnessDiagnosticReport> {
  const cfg = requireOpenCodeConfig(context.cfg)
  const bootState: OpenCodeBootState = context.bootState
  const monitor = context.resources()
  const [resourcesNow, runtime] = await Promise.all([
    monitor ? monitor.tick('diag').catch(() => null) : Promise.resolve(null),
    runtimeConvergenceReport(undefined, undefined, catalogSnapshotForHealth).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    })),
  ])
  const daemonLog = daemonLogFilePath()
  const opencodeLog = opencodeLogFilePath(home)

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
    opencode: {
      state: opencode.getState(),
      pid: opencode.getPid(),
      port: opencode.getActivePort(),
      internal_url: opencode.getInternalUrl(),
      binary: opencode.getBinaryPath(),
      port_pair: [cfg.opencodeInternalPort, cfg.opencodeStandbyPort],
      session_id: bootState.initialRuntimeSessionId ?? null,
      log_file: opencodeLog,
    },
    boot: {
      repo_materialization_error: bootState.repoMaterializationError,
      initial_session_error: bootState.initialRuntimeSessionError ?? null,
      timeline: bootState.timeline,
    },
    resources: projectOpenCodeResourceSnapshot(resourcesNow),
    resources_previous: projectOpenCodeResourceSnapshot(monitor?.latest() ?? null),
    runtime,
    logs: {
      tail,
      daemon: daemonLog ? tailFile(daemonLog, tail) : null,
      opencode: tailFile(opencodeLog, tail),
    },
  }
}

export function createOpenCodeDiagnosticsService(
  opencode: Opencode,
  home: string = OPENCODE_HOME,
): HarnessDiagnosticsService {
  return {
    // Every session feature the pi harness answers 501 for is native here.
    capabilities: [...RUNTIME_CAPABILITIES],
    catalogSnapshot: catalogSnapshotForHealth,
    health: (context, query) => readOpenCodeHealth(context, opencode, query),
    report: (context, tail) => readOpenCodeDiagnosticReport(opencode, home, context, tail),
    logSources: () => ['daemon', 'opencode'],
    readLog(source, lines) {
      if (source !== 'daemon' && source !== 'opencode') throw new Error(`Unknown log source: ${source}`)
      const path = source === 'daemon' ? daemonLogFilePath() : opencodeLogFilePath(home)
      return {
        label: path ?? '(daemon file sink disabled: KORTIX_DAEMON_LOG_FILE=off)',
        text: path ? tailFile(path, lines) : null,
      }
    },
  }
}
