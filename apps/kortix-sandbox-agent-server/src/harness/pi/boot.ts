/**
 * The pi session boot.
 *
 * The host steps — git identity, egress shim, agent env file, proxy up FIRST —
 * then the config and the workspace in parallel, and the runtime on the config
 * alone. "Start the runtime"
 * is building an in-process object (tens of milliseconds), not spawning and
 * probing a server. There is no early-spawn, no config-dir dance, no
 * bind-window and no readiness lottery. `pi-ready` follows the config release
 * (`config-release-proven`), never the workspace checkout.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from '../shared/agent-env-file'
import { relayBootTimelineToApi } from '../shared/boot-timeline-relay'
import { createRuntimeAuditRelay, type AuditRelay } from '../shared/audit-relay'
import { createSessionTreeWatch, scheduleRuntimeProjectionPush } from '../shared/projection-relay'
import {
  claimInitialTurn,
  relayPermission,
  relayQuestion,
  relayRuntimeSession,
  relaySteerRead,
  relayTurnAccepted,
  relayTurnBegin,
  relayTurnEnd,
} from '../shared/turn-relay'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import { scheduleHistoryBackfill } from '@/services/workspace-provider/git'
import { backfillAfterHydration, provideWorkspace } from '@/services/workspace-provider/workspace-provider'
import { startEgressShim } from '@/services/egress-shim'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
} from '@/lib/git/git'
import type { HarnessBootContext } from '../harness'
import { kortixEventBus } from '@/services/event-bus/kortix-event-bus'
import { startLlmProxy } from '@/services/llm-proxy/llm-proxy'
import { logger } from '@/lib/log/logger'
import { runSandboxOnBoot } from '../shared/on-boot'
import { createProjectEnvStore } from '@/services/sandbox-env/project-env'
import { configureRuntimeConvergence, scheduleRuntimeAssetsReconcile } from '@/services/runtime-assets/runtime-assets'
import { configureRuntimeTruth, startRuntimeTruthTicker } from '@/services/runtime-assets/runtime-truth'
import { ConvergeBusyError } from '@/services/config-provider/release'
import type { PiBootState } from './boot-state'
import type { PiConfig } from './config'
import type { PiRuntimeHooks } from './runtime'
import { createPiHarnessService, type PiHarnessService } from './service'
import { createPiSessionLogPort } from './session-log'
import { startSessionLogJournal } from '../shared/session-log-journal'
import { reconcileSessionLog, type SessionLogBoot } from '../shared/session-log-boot'
import { readPiSnapshot } from './session-log-restore'

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
  // A turn's end is relayed after its begin: a refused `/summarize` ends within milliseconds, and a
  // begin that lands after the end adopts a new turn that nothing ends.
  const turnBegins = new Map<string, Promise<void>>()
  const sessionTreeChanged = createSessionTreeWatch()
  const hooks: PiRuntimeHooks = {
    onTurnBegin: ({ rootId, messageId }) => {
      turnBegins.set(messageId, relayTurnBegin(rootId, messageId))
    },
    onTurnEnd: ({ rootId, messageId, status, error }) => {
      kortixEventBus().publishDaemon('kortix.turn', { runtime_session_id: rootId, verdict: status, error: error ?? null }, rootId)
      const begun = turnBegins.get(messageId)
      turnBegins.delete(messageId)
      if (relayedTurnEnds.has(messageId)) return
      void Promise.resolve(begun).then(() => relayTurnEnd({ runtimeSessionId: rootId, messageId, status, error })).then((settled) => {
        if (settled) relayedTurnEnds.add(messageId)
      })
    },
    onSteerRead: ({ rootId, messageId }) => {
      void relaySteerRead(rootId, messageId)
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
      // A child session or a new title: apps/api lists the tree from the pushed projection.
      if (sessionTreeChanged(frame)) scheduleRuntimeProjectionPush(frame.type)
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

  // The session log's boot reconcile (P6.4, shared/session-log-boot.ts), beside
  // the checkout: a restore writes pi's dump, which needs no /workspace, and the
  // runtime loads it at start. A failed reconcile fails the boot below.
  const sessionLog: Promise<SessionLogBoot | null | Error> = sessionId
    ? reconcileSessionLog(
        createPiSessionLogPort(() => readPiSnapshot(cfg.piStateDir, sessionId), { stateDir: cfg.piStateDir, sessionId, cwd: cfg.projectTarget || cfg.workspace }),
      ).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
    : Promise.resolve(null)

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

  // Two independent providers, started together:
  //   - the config provider (config-release.ts) downloads the release pi
  //     boots from, from S3 first, and never reads `/workspace`;
  //   - the workspace provider (git | prefer-s3 | require-s3) checks out the
  //     project for the agent's tools.
  // pi starts on the config alone. The workspace gates turns, not the runtime:
  // the readiness gate (service.ts) holds every turn until it lands.
  const configReady = harness.releases.boot(bootMark)
  if (cfg.autoClone) bootState.workspaceReady = false
  const workspace: Promise<string | null> = cfg.autoClone
    ? provideWorkspace(cfg, {
        onSummary: (summary) => {
          bootState.workspaceProvider = summary
        },
      })
        .then(async (result) => {
          if (result.provider === 's3') bootState.deferredHistoryBackfill = backfillAfterHydration(cfg, result)
          if (!bootState.deferredHistoryBackfill) scheduleHistoryBackfill(cfg, cfg.projectTarget)
          await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((err) => {
            logger.warn('[boot] repo-local git credential helper setup failed', { err: (err as Error).message })
          })
          return null
        })
        .catch((err) => {
          bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
          logger.error('[boot] repo materialization failed', err)
          return bootState.repoMaterializationError
        })
        .finally(() => {
          bootState.workspaceReady = true
        })
    : Promise.resolve('this box does not clone the project')

  await configReady
  // Releases off (an API from before they graduated, or no API): the working
  // tree IS the config, so pi waits for it. The only wait on the workspace.
  if (harness.releases.projectRoot() === undefined) await workspace

  const logBoot = await sessionLog
  if (logBoot instanceof Error) {
    bootState.initialRuntimeSessionError = `session log restore failed: ${logBoot.message}`
    logger.error('[boot] session log restore failed; the session does not start', { err: bootState.initialRuntimeSessionError })
    return
  }
  try {
    await harness.lifecycle.start()
  } catch (err) {
    logger.error('[boot] pi runtime failed to start; the box stays observable', { err: (err as Error).message })
    return
  }
  const runtime = harness.runtime()!
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

  // Everything below runs in the project: hooks, the first turn.
  await workspace
  if (bootState.repoMaterializationError) return
  runSandboxOnBoot(cfg)

  if (!sessionId) {
    // A builder boot with no session (image warm-up): nothing to claim or pin.
    logger.info('[boot] no session bound to this box; pi idle', { timeline: bootState.timeline })
    return
  }

  // ── The session log (P2.5, P6.4) ────────────────────────────────────────
  // Before the first turn, so its turn end flushes it, at the generation and
  // with the cursors the boot reconcile returned.
  if (logBoot && startSessionLogJournal(createPiSessionLogPort(() => harness.runtime()?.sessionLogSnapshot() ?? null), logBoot)) {
    logger.info('[session-log] journal started', { harness: 'pi', generation: logBoot.generation, restored: logBoot.cursors.length > 0, dumpDir: process.env.KORTIX_SESSION_LOG_DUMP_DIR?.trim() || null })
  }

  // ── The session's root and its first turn ───────────────────────────────
  // One deterministic root per session: nothing to create, nothing to list.
  void relayRuntimeSession(runtime.rootId)
  const claim = await claimPromise
  if (claim?.prompt) {
    try {
      // ponytail: pi's admission takes plain text only, so the harness context
      // still rides inside the prompt here; the transcript shows the caller's
      // words plus the contract tail until pi grows a synthetic-part carrier
      // (OpenCode already delivers it as a model-only part).
      const text = claim.context ? `${claim.prompt}\n\n${claim.context}` : claim.prompt
      const admitted = runtime.admit({ messageID: claim.messageId, text, files: [] })
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
