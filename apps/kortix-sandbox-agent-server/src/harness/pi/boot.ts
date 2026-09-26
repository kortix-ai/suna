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
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from '../../agent-env-file'
import { relayBootTimelineToApi } from '../../boot-timeline-relay'
import { materializeProject } from '../../config-provider/config-provider'
import { startEgressShim } from '../../egress-shim'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  scheduleHistoryBackfill,
} from '../../git'
import type { HarnessBootContext } from '../harness'
import { kortixEventBus } from '../../kortix-event-bus'
import { startLlmProxy } from '../../llm-proxy'
import { logger } from '../../logger'
import { runSandboxOnBoot } from '../../on-boot'
import { createProjectEnvStore } from '../../project-env'
import { startProxy } from '../../proxy'
import { configureRuntimeConvergence, scheduleRuntimeAssetsReconcile } from '../../runtime-assets'
import { installShutdownHandlers } from '../../shutdown'
import type { PiBootState } from './boot-state'
import type { PiConfig } from './config'
import {
  claimInitialTurn,
  relayBootstrapPin,
  relayInitialTurnAccepted,
  relayQuestion,
  relayTurnBegin,
  relayTurnEnd,
  schedulePiProjectionPush,
} from './relay'
import type { PiRuntimeHooks } from './runtime'
import { createPiHarnessService } from './service'

export async function runPi(context: HarnessBootContext & { cfg: PiConfig; bootState: PiBootState }): Promise<void> {
  const { cfg, bootTime, bootState, bootMark, staticWeb } = context
  const sessionId = (process.env.KORTIX_SESSION_ID ?? '').trim()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
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

  // ── Serve BEFORE doing any slow work ────────────────────────────────────
  const hooks: PiRuntimeHooks = {
    onTurnBegin: ({ rootId, messageId }) => {
      void relayTurnBegin(rootId, messageId).catch((err) => logger.warn('[pi] turn-begin relay failed', { err: (err as Error).message }))
    },
    onTurnEnd: ({ rootId, messageId, status, error }) => {
      kortixEventBus().publishDaemon('kortix.turn', { opencode_session_id: rootId, verdict: status, error: error ?? null }, rootId)
      void relayTurnEnd(rootId, messageId, status, error).catch((err) => logger.warn('[pi] turn-end relay failed', { err: (err as Error).message }))
    },
    onQuestionAsked: (request, answer) => {
      void relayQuestion(request, answer).catch((err) => logger.warn('[pi] question relay failed', { err: (err as Error).message }))
    },
  }
  const harness = createPiHarnessService(cfg, projectEnv, { onStartupMark: bootMark, hooks, sessionId })
  const server = startProxy(cfg, harness, bootTime, bootState, projectEnv, staticWeb.port)
  const shutdown = installShutdownHandlers(harness.lifecycle, server, staticWeb)
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

  if (bootState.repoMaterializationError) return
  runSandboxOnBoot(cfg)

  if (!sessionId) {
    // A builder boot with no session (image warm-up): nothing to claim or pin.
    logger.info('[boot] no session bound to this box; pi idle', { timeline: bootState.timeline })
    return
  }

  // ── The session's root and its first turn ───────────────────────────────
  // One deterministic root per session: nothing to create, nothing to list.
  void relayBootstrapPin(runtime.rootId)
  const claim = await claimPromise
  if (claim?.prompt) {
    try {
      const admitted = runtime.admit({ messageID: claim.messageId, text: claim.prompt, files: [] })
      bootMark('initial-prompt-delivered')
      // Published AFTER admission, like OpenCode's publish-after-prompt: the
      // control plane must never promote a `delivering` record for a turn the
      // runtime has not accepted.
      bootState.initialOpenCodeSessionId = runtime.rootId
      void relayInitialTurnAccepted(runtime.rootId, admitted.messageId, claim.turnToken)
        .then(() => bootMark('initial-turn-accepted'))
        .catch((err) => logger.warn('[boot] initial turn acceptance relay failed', { err: (err as Error).message }))
    } catch (err) {
      bootState.initialOpenCodeSessionError = err instanceof Error ? err.message : String(err)
      logger.error('[boot] initial prompt admission failed', { err: bootState.initialOpenCodeSessionError })
      return
    }
  } else {
    bootState.initialOpenCodeSessionId = runtime.rootId
  }
  bootMark('runtime-ready')
  logger.info('[boot] pi session ready', { rootId: runtime.rootId, timeline: bootState.timeline })
  relayBootTimelineToApi(bootState.timeline)
  if (bootState.deferredHistoryBackfill) {
    const run = bootState.deferredHistoryBackfill
    bootState.deferredHistoryBackfill = null
    run()
  }
  schedulePiProjectionPush(() => {
    const doc = runtime.stateDoc()
    return { doc, etag: runtime.stateEtag(doc) }
  }, 'boot')
  scheduleRuntimeAssetsReconcile(cfg)
}
