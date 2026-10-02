/**
 * The pi session boot.
 *
 * Same host steps as the OpenCode boot, in the same order — git identity,
 * egress shim, agent env file, proxy up FIRST, then the workspace, then the
 * runtime — with one difference that is the whole point: "start the runtime"
 * is building an in-process object (tens of milliseconds), not spawning and
 * probing a server. There is no early-spawn, no config-dir dance, no
 * bind-window and no readiness lottery. `pi-ready` follows `repo-materialized`
 * as fast as the model catalog reads from disk.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from '../shared/agent-env-file'
import { relayBootTimelineToApi } from '../shared/boot-timeline-relay'
import { createRuntimeAuditRelay, type AuditRelay } from '../shared/audit-relay'
import { scheduleRuntimeProjectionPush } from '../shared/projection-relay'
import {
  claimInitialTurn,
  relayPermission,
  relayQuestion,
  relayRuntimeSession,
  relayTurnAccepted,
  relayTurnBegin,
  relayTurnEnd,
} from '../shared/turn-relay'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import { materializeProject } from '@/services/config-provider/config-provider'
import { startEgressShim } from '@/services/egress-shim'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  scheduleHistoryBackfill,
} from '@/lib/git/git'
import type { HarnessBootContext } from '../harness'
import { kortixEventBus } from '@/services/event-bus/kortix-event-bus'
import { startLlmProxy } from '@/services/llm-proxy/llm-proxy'
import { logger } from '@/lib/log/logger'
import { runSandboxOnBoot } from '../shared/on-boot'
import { createProjectEnvStore } from '@/services/sandbox-env/project-env'
import { configureRuntimeConvergence, scheduleRuntimeAssetsReconcile } from '@/services/runtime-assets/runtime-assets'
import { configureRuntimeTruth, startRuntimeTruthTicker } from '@/services/runtime-assets/runtime-truth'
import { ConvergeBusyError } from '@/services/config-release/release'
import type { PiBootState } from './boot-state'
import type { PiConfig } from './config'
import type { PiRuntimeHooks } from './runtime'
import { createPiHarnessService, type PiHarnessService } from './service'

export async function runPi(context: HarnessBootContext & { cfg: PiConfig; bootState: PiBootState }): Promise<void> {
  const { cfg, bootState, bootMark, serve } = context
  const sessionId = (process.env.KORTIX_SESSION_ID ?? '').trim()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_RUNTIME_SESSION ?? '').trim() === '1'
  const home = homedir()

  try {
    await configureGlobalGitIdentity(cfg, home)
  } catch (err) {
    logger.warn('[boot] default git identity setup failed', { err: (err as Error).message })
  }
  try {
    await configureGitCredentialHelper(cfg, home)
  } catch (err) {
    logger.warn('[boot] git credential helper setup failed', { err: (err as Error).message })
  }
  bootMark('git-identity')

  const projectEnv = createProjectEnvStore()
  if (!agentEnvDirIsTmpfs()) {
    logger.error('[boot] /dev/shm is not tmpfs — agent secret file would persist to disk; check the sandbox runtime mount')
  }
  await startEgressShim()
  if (!writeAgentEnvFile(projectEnv)) {
    logger.error('[boot] failed to write agent secret env file; agent shells will lack project secrets')
  }

  // The tool audit trail (shared/audit-relay.ts): every frame the runtime
  // publishes, sanitized and spooled until apps/api accepts it. A spool that
  // cannot load marks the runtime unhealthy, exactly as it does on OpenCode.
  let auditRelay: AuditRelay | null = null
  try {
    auditRelay = createRuntimeAuditRelay(
      'pi',
      process.env.KORTIX_AUDIT_SPOOL_PATH?.trim() || join(resolveKortixRuntimeStateDirectory(), 'runtime-audit-spool.json'),
    )
  } catch (err) {
    bootState.auditRelayError = err instanceof Error ? err.message : String(err)
    logger.error('[pi] audit relay failed to start; runtime is unhealthy', { err: bootState.auditRelayError })
  }
  const flushAuditRelay = () => {
    void auditRelay?.stop().catch((err) => logger.warn('[pi] audit relay shutdown flush failed', { err: (err as Error).message }))
  }
  process.once('SIGTERM', flushAuditRelay)
  process.once('SIGINT', flushAuditRelay)

  // ── Serve BEFORE doing any slow work ────────────────────────────────────
  const relayedTurnEnds = new Set<string>()
  const hooks: PiRuntimeHooks = {
    onTurnBegin: ({ rootId, messageId }) => {
      void relayTurnBegin(rootId, messageId)
    },
    onTurnEnd: ({ rootId, messageId, status, error }) => {
      kortixEventBus().publishDaemon('kortix.turn', { runtime_session_id: rootId, verdict: status, error: error ?? null }, rootId)
      if (relayedTurnEnds.has(messageId)) return
      void relayTurnEnd({ runtimeSessionId: rootId, messageId, status, error }).then((settled) => {
        if (settled) relayedTurnEnds.add(messageId)
      })
    },
    onQuestionAsked: (request, answer) => {
      void relayQuestion(request).then((answers) => {
        if (answers) answer(answers)
      })
    },
    // Report only: apps/api pushes "needs your approval"; the request stays open for the user.
    onPermissionAsked: (request) => {
      void relayPermission(request)
    },
    onFrame: (frame) => {
      if (!auditRelay) return
      try {
        auditRelay.enqueue(frame)
      } catch (err) {
        bootState.auditRelayError = err instanceof Error ? err.message : String(err)
        logger.error('[pi] audit relay persistence failed; runtime is unhealthy', { err: bootState.auditRelayError })
      }
    },
  }
  const harness = createPiHarnessService(cfg, projectEnv, { onStartupMark: bootMark, hooks, sessionId })
  const { shutdown } = serve(harness, projectEnv)
  configureRuntimeConvergence({
    assets: harness.assets,
    turnInFlight: async () => harness.runtime()?.busy() ?? null,
    exit: (code) => shutdown({ reason: 'agent-swap', exitCode: code }),
  })
  bootMark('proxy-up')

  // The first turn's claim is a read; prefetch it while the workspace lands.
  const claimPromise = bootstrapSession && sessionId
    ? claimInitialTurn()
        .then((claim) => {
          if (!bootState.timeline.some((mark) => mark.label === 'initial-turn-claimed')) bootMark('initial-turn-claimed')
          return claim
        })
        .catch((err) => {
          logger.warn('[boot] initial-turn claim failed', { err: (err as Error).message })
          return null
        })
    : Promise.resolve(null)

  // Every gateway session routes model traffic through the localhost LLM proxy.
  const hasGateway = Boolean(process.env.KORTIX_LLM_BASE_URL && process.env.KORTIX_TOKEN)
  if (hasGateway && !process.env.KORTIX_LLM_PROXY_URL && process.env.KORTIX_LLM_PROXY_DISABLE !== '1') {
    const llmPort = Number(process.env.KORTIX_LLM_PROXY_PORT) || 4319
    const llmUrl = startLlmProxy(llmPort, process.env.KORTIX_LLM_BASE_URL, process.env.KORTIX_TOKEN)
    if (llmUrl) {
      process.env.KORTIX_LLM_PROXY_URL = llmUrl
      bootMark('llm-proxy-started')
    }
  }

  // The config release the runtime starts on (config-release.ts): fetched,
  // verified and sealed beside the checkout. `lifecycle.start()` joins it.
  void harness.releases.boot(bootMark)

  // Fresh-boot acquisition goes through the config-provider coordinator
  // (git | prefer-s3 | require-s3), exactly as the OpenCode boot does.
  if (cfg.autoClone) {
    bootState.workspaceReady = false
    await materializeProject(cfg, {
      bootMark,
      onSummary: (summary) => {
        bootState.configProvider = summary
      },
    })
      .then((result) => {
        if (result.provider === 's3') {
          const hydration = result.hydration ?? Promise.resolve()
          bootState.deferredHistoryBackfill = () => {
            void hydration.then(
              () => scheduleHistoryBackfill(cfg, cfg.projectTarget),
              () => scheduleHistoryBackfill(cfg, cfg.projectTarget),
            )
          }
        }
      })
      .catch((err) => {
        bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
        logger.error('[boot] repo materialization failed', err)
      })
  }
  bootMark('repo-materialized')
  if (cfg.autoClone && !bootState.repoMaterializationError) {
    if (!bootState.deferredHistoryBackfill) scheduleHistoryBackfill(cfg, cfg.projectTarget)
    await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((err) => {
      logger.warn('[boot] repo-local git credential helper setup failed', { err: (err as Error).message })
    })
  }
  bootState.workspaceReady = true

  try {
    await harness.lifecycle.start()
  } catch (err) {
    logger.error('[boot] pi runtime failed to start; the box stays observable', { err: (err as Error).message })
    return
  }
  const runtime = harness.runtime()!
  runtime.markWorkspaceReady()
  logger.info('[boot] proxy up; pi runtime ready', { servicePort: cfg.servicePort, rootId: runtime.rootId })
  convergeAfterReady(harness)
  // The reconcile floor: every 60 s the box re-checks its release and its
  // runtime assets, so no failure is permanent. pi has no model catalog to converge.
  configureRuntimeTruth({
    reconcileAssets: () => scheduleRuntimeAssetsReconcile(cfg),
    readConfigRelease: () => harness.releases.report(),
    reconcileConfigRelease: async () => {
      await harness.releases.converge(harness.runtime()).catch((err) => {
        if (!(err instanceof ConvergeBusyError)) logger.warn('[runtime-truth] config-release tick failed', { err: String(err) })
      })
    },
  })
  startRuntimeTruthTicker()

  if (bootState.repoMaterializationError) return
  runSandboxOnBoot(cfg)

  if (!sessionId) {
    // A builder boot with no session (image warm-up): nothing to claim or pin.
    logger.info('[boot] no session bound to this box; pi idle', { timeline: bootState.timeline })
    return
  }

  // ── The session's root and its first turn ───────────────────────────────
  // One deterministic root per session: nothing to create, nothing to list.
  void relayRuntimeSession(runtime.rootId)
  const claim = await claimPromise
  if (claim?.prompt) {
    try {
      const admitted = runtime.admit({ messageID: claim.messageId, text: claim.prompt, files: [] })
      bootMark('initial-prompt-delivered')
      // Published AFTER admission, like OpenCode's publish-after-prompt: the
      // control plane must never promote a `delivering` record for a turn the
      // runtime has not accepted.
      bootState.initialRuntimeSessionId = runtime.rootId
      void relayTurnAccepted(runtime.rootId, admitted.messageId, claim.turnToken)
        .then(() => bootMark('initial-turn-accepted'))
        .catch((err) => logger.warn('[boot] initial turn acceptance relay failed', { err: (err as Error).message }))
    } catch (err) {
      bootState.initialRuntimeSessionError = err instanceof Error ? err.message : String(err)
      logger.error('[boot] initial prompt admission failed', { err: bootState.initialRuntimeSessionError })
      return
    }
  } else {
    bootState.initialRuntimeSessionId = runtime.rootId
  }
  bootMark('runtime-ready')
  logger.info('[boot] pi session ready', { rootId: runtime.rootId, timeline: bootState.timeline })
  relayBootTimelineToApi(bootState.timeline)
  if (bootState.deferredHistoryBackfill) {
    const run = bootState.deferredHistoryBackfill
    bootState.deferredHistoryBackfill = null
    run()
  }
  scheduleRuntimeProjectionPush('boot')
  scheduleRuntimeAssetsReconcile(cfg)
}

/**
 * One convergence once pi is ready. A box that booted on a fallback (the API
 * or the archive store could not be reached) moves onto the desired release
 * here. Detached: it never delays readiness, and a turn in flight defers it to
 * the API's next trigger.
 */
function convergeAfterReady(harness: PiHarnessService): void {
  void harness.releases
    .converge(harness.runtime())
    .then((response) => {
      logger.info('[boot] config convergence after ready', {
        outcome: response.outcome,
        releaseId: response.config.release_id,
        source: response.config.source,
        reason: response.reason,
      })
    })
    .catch((err) => {
      if (err instanceof ConvergeBusyError) return
      logger.warn('[boot] config convergence after ready failed', { err: String(err) })
    })
}
