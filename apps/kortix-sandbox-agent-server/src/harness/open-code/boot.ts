import type { RuntimePermissionRequest, RuntimeQuestionRequest } from '@kortix/api-contract/transcript'
import { retryUntilInitialSessionEstablished, maybeCreateInitialOpencodeSession, finalizeOrphanedTurn, unrequestedAbortCause, finalizeInitialSession, markSeedBakedSession } from './initial-session'
import { reconcileInitialTurnAcceptanceToApi, createInitialOpenCodeSession, INITIAL_TURN_PICKUP_GRACE_MS } from './initial-prompt'
export { initialSessionRetryDelayMs, finalizeInitialSession, retryUntilInitialSessionEstablished, publishInitialOpenCodeSessionAfterPrompt, finalizeOrphanedTurn, waitForOpencodeRootReadiness, resolveExistingRoot, reusedRootAlreadyDelivered, unrequestedAbortCause } from './initial-session'
export type { ExistingRootResult } from './initial-session'
export { createInitialOpenCodeSession, deliverInitialOpenCodePrompt, reconcileInitialTurnAcceptanceToApi, waitForInitialSessionCreate, resolveOpencodeModel, buildInitialPromptBody, INITIAL_TURN_PICKUP_GRACE_MS } from './initial-prompt'
export type { InitialTurnAcceptanceReconciliation } from './initial-prompt'
import { armSeedAdoption, runWarmSeedMode } from './warm-seed'
import { relayTurnBeginAfterInitialAcceptance, relayTurnBeginToApi, relayTurnEndToApi, reconcileFinishedFirstTurn, isRootOpencodeSession } from './turn-relay'
export { __resetRelayedTurnSignatures, __resetRelayedTurnBegins, relayTurnBeginAfterInitialAcceptance, relayTurnBeginToApi, relayTurnEndToApi, relayOrphanedTurnEndToApi, reconcileFinishedFirstTurn } from './turn-relay'
import { publishOpenCodeEvent } from './event-bus'
import { noteOpencodeStopRequested, type AbortedTurnVerdict } from './instance-guard'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from '../shared/agent-env-file'
import { runSandboxOnBoot } from '../shared/on-boot'
import { bootstrapRuntimeSessionRequested, loadOpenCodeConfig as loadConfig, type OpenCodeConfig as Config } from './config'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  materializeRepo,
  materializeScaffoldSeed,
  materializeProjectSeed,
  scheduleHistoryBackfill,
} from '@/lib/git/git'
import { logger } from '@/lib/log/logger'
import {
  catalogIsDegraded,
  hasKortixLlmGateway,
  missingManagedModelIds,
  refreshGatewayCatalogFile,
  scheduleCatalogWarm,
  settleManagedModelsPrefetch,
  startManagedModelsPrefetch,
  writeManagedOverlayCatalogFile,
  waitForOpencodeReady,
  type Opencode,
} from './lifecycle'
import { relayBootTimelineToApi } from '../shared/boot-timeline-relay'
import { materializeProject } from '@/services/config-provider/config-provider'
import { registerRuntimeStateReader, scheduleRuntimeProjectionPush } from '../shared/projection-relay'
import { ConvergeBusyError } from '@/services/config-release/release'
import { convergeConfigRelease } from './config-release'
import { bootOpenCodeConfig } from './boot-config-path'
import { OPENCODE_HOME } from './paths'
import { retryDeferredOpencodeEnvRestart, restoreOpencodeRuntimeEnvSnapshotIfUnset } from './control'
// Converge `/usr/local/bin/kortix` + the managed-skill overlay on the API this
// sandbox talks to. Called at BOTH of `startSessionRuntime`'s readiness exits —
// which is also the warm-fork adoption path, since `adopt()` ends in
// `startSessionRuntime` — so every way a session comes up reconciles once.
// Strictly AFTER `bootMark('opencode-ready')` and never awaited: it adds zero
// milliseconds to the readiness the API and the frontend poll for.
import {
  configureRuntimeConvergence,
  convergeRuntimeAssetsAtTurnEnd,
  scheduleRuntimeAssetsReconcile,
} from '@/services/runtime-assets/runtime-assets'
import { wireRuntimeTruth } from './runtime-truth-glue'
import { isSharedSeedBakedRoot } from './opencode-fork-root'
import { flattenOpencodeError, type OpencodeTurnError } from './events'
import { createTurnAutoResumer } from './turn-auto-resume'
import { kortixEventBus } from '@/services/event-bus/kortix-event-bus'
import { CATALOG_MOVING_EVENT_TYPES, runtimeStateStore } from './runtime-state-projection'
import { createRuntimeAuditRelay } from '../shared/audit-relay'
import {
  claimInitialTurn,
  claimedRuntimeSessionPin,
  initialTurnClaim,
  relayPermission,
  relayRuntimeSession,
  relayTurnAbandoned,
  relayTurnAccepted,
  relayTurnBegin,
  relayTurnEnd,
  resetTurnBeginRelaysForTests,
  type TurnEndFrame,
} from '../shared/turn-relay'
import { relayQuestionToApi } from './question-relay'
import { readControlPlaneEnv, sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { observeIdleForRunaway } from './runaway-turn-guard'
import {
  openCodeSeedBakedPinPath,
  openCodeSessionPinPath,
  readOpenCodeSessionPin,
  migratePreW3AuditSpool,
  resolveOpenCodeAuditSpoolPath,
  writeOpenCodeSeedBakedPin,
  writeOpenCodeSessionPin,
} from './runtime-state'
import { createProjectEnvStore } from '@/services/sandbox-env/project-env'
import { startEgressShim } from '@/services/egress-shim'
import {
  startLlmProxy,
  setLlmProxyToken,
  llmProxyReady,
  llmProxyBaseUrl,
  startConnectorProxy,
  setConnectorProxyToken,
  connectorProxyReady,
  connectorProxyBaseUrl,
} from '@/services/llm-proxy/llm-proxy'
import type { OpenCodeBootState as SandboxBootState } from './boot-state'
import { createOpenCodeHarnessService, type OpenCodeHarnessService } from './service'
import type { DaemonServer } from '../contract/server'
import { observeOpencodeDelivery, opencodeTurnInFlight, openAssistantMessageIdOnRoot } from './opencode-turn-state'
import { sessionTokenPresumedDead } from '@/lib/kortix-api/session-token-health'
import type { HarnessBootContext } from '../harness'

/** The projection relay pushes OpenCode's `/kortix/runtime/state` document. */
function registerOpenCodeStateReader(): void {
  registerRuntimeStateReader(async () => {
    const store = runtimeStateStore()
    if (!store) return null
    const { doc, etag } = await store.read()
    return { doc, etag }
  })
}

/** Run the existing OpenCode cold/session boot behind the harness boundary. */
export async function runOpenCode(context: HarnessBootContext & { cfg: Config; bootState: SandboxBootState }): Promise<void> {
  const { cfg, bootState, bootMark, serve } = context
  // FIRST THING, before anything spawns or binds: restore the config-affecting
  // opencode runtime env this box last applied, so this fresh daemon process
  // does not read its own restart as a config change. `process.env` is
  // process-local — see `restoreOpencodeRuntimeEnvSnapshotIfUnset`'s doc for
  // the 2026-09-29 incident this closes.
  restoreOpencodeRuntimeEnvSnapshotIfUnset()
  registerOpenCodeStateReader()
  const bootstrapSession = bootstrapRuntimeSessionRequested()
  try {
    await configureGlobalGitIdentity(cfg, OPENCODE_HOME)
  } catch (err) {
    logger.warn('[boot] default git identity setup failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  // Make `git push`/`git fetch` against the project remote authenticate
  // transparently from any shell the agent uses — no token juggling, no
  // askpass. Best-effort: a sandbox with no managed remote just skips it.
  try {
    await configureGitCredentialHelper(cfg, OPENCODE_HOME)
  } catch (err) {
    logger.warn('[boot] git credential helper setup failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  bootMark('git-identity')

  // The normal OpenCode config dir lives inside the repo. A compiled runtime
  // extracts the exact Git revision's OpenCode config to
  // tmpfs before this bundle executes. That lets OpenCode start while the full
  // checkout extracts. The first directory-scoped request still waits below
  // for repoMaterializePromise, so tools never observe a partial workspace.
  const projectEnv = createProjectEnvStore()
  if (!agentEnvDirIsTmpfs()) {
    logger.error('[boot] /dev/shm is not tmpfs — agent secret file would persist to disk; check the sandbox runtime mount')
  }
  // Egress-enforced secrets — the one mechanism, on every provider. Started
  // BEFORE the first writeAgentEnvFile below, because that file is how the
  // proxy + CA variables reach the agent's shells — and before opencode spawns,
  // because the shim's port has to be listening by the time anything can make a
  // request. Returns null for the ordinary session that holds no boundary
  // secret; see src/services/egress-shim/index.ts.
  await startEgressShim()
  if (!writeAgentEnvFile(projectEnv)) {
    logger.error('[boot] failed to write agent secret env file; agent shells will lack project secrets')
  }
  // ── Serve BEFORE doing any slow work ────────────────────────────────────
  // The proxy (and with it /kortix/health) used to bind only after the clone
  // AND the opencode spawn, so a live VM answered nothing for ~9s — the API and
  // frontend were blind for most of the boot and every readiness poll in that
  // window hit a closed port (measured 2026-07-25: VM up at 2.5s, first health
  // answer at 13s). Nothing about the proxy needs the repo: it already 503s
  // cleanly while opencode is still starting, and /kortix/health never touches
  // opencode at all. So bind first, then clone.
  //
  // The lifecycle is created here with the BAKED config dir because the
  // project's own dir lives inside the repo and isn't known yet; it is
  // reconfigured with the resolved dir below, before the process is ever
  // spawned. `reconfigure` only rewrites state read at spawn time, so this is
  // exactly equivalent to constructing it late.
  // EVERY boot spawns OpenCode before the config is decided, so the proxy holds
  // every caller off until `bootOpenCodeConfig` proves what this box runs and
  // opens the gate. Set before the lifecycle exists, so no window is open.
  bootState.workspaceReady = false
  const harness = createOpenCodeHarnessService(cfg, projectEnv, {
    onStartupMark: bootMark,
    onFirstListeningResponse: () => {
      if (bootState.timeline.some((mark) => mark.label === 'opencode-http-listening')) return
      bootMark('opencode-http-listening')
    },
    onFirstReadyResponse: () => {
      if (bootState.timeline.some((mark) => mark.label === 'opencode-session-api-ready')) return
      bootMark('opencode-session-api-ready')
    },
    // ALWAYS closed at first. `bootOpenCodeConfig` spawns OpenCode before the
    // checkout and before the config is decided, so no Instance — and no tool
    // registry — may be built until it opens the gate, after its proof.
    deferDirectoryProbe: true,
  onUnplannedRespawn: () => {
      // opencode died on its own and is back. Close whatever turn it was
      // writing, or the client streams a part that will never complete.
      const pinned = readOpenCodeSessionPin()
      if (!pinned) return
      // RETURNED, not fire-and-forget. The boolean is whether a turn was really
      // interrupted, and the reload surfaces it so the user can be told to
      // continue instead of watching a turn stop for no stated reason.
      return finalizeOrphanedTurn(
        opencode.getInternalUrl(),
        process.env.KORTIX_WORKSPACE || '/workspace',
        pinned,
      ).then((finalized) => {
        if (finalized) {
          logger.info('[opencode] finalized a turn orphaned by an unplanned exit', {
            sessionId: pinned,
          })
        }
        return finalized
      })
    },
    // Read on the OUTGOING opencode, an instant before a verified reload kills
    // it. Nothing else can answer for the turn it was writing afterwards: the
    // replacement was never handed that turn's stream, so its own finalize
    // finds nothing to close. The id travels up in the converge response and
    // the API settles the row and redelivers the prompt.
    readOpenTurn: (baseUrl) =>
      openAssistantMessageIdOnRoot(
        baseUrl,
        process.env.KORTIX_WORKSPACE || '/workspace',
        readOpenCodeSessionPin(),
      ),
  })
  const opencode = harness.native
  const { server, shutdown } = serve(harness, projectEnv)
  // Hand the convergence machinery this session's live runtime, once.
  //
  // Two things need it. opencode convergence restarts opencode, so it goes
  // through the lifecycle that owns spawn/respawn/dispose — never behind its
  // back. And a staged daemon update exits `75` through the SAME clean shutdown
  // a SIGTERM takes: opencode is a child of this process, so a bare
  // `process.exit` would leave the relaunched daemon fighting an orphan for the
  // opencode port.
  configureRuntimeConvergence({
    assets: harness.assets,
    turnInFlight: () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace),
    exit: (code) => shutdown({ reason: 'agent-swap', exitCode: code }),
  })
  bootMark('proxy-up')

  // The initial-turn claim is a read (it returns the API's `delivering` record
  // for this session; nothing server-side changes). It used to run only after
  // OpenCode answered, costing one control-plane round trip on the critical
  // path. Prefetch it now — memoized in the shared claimInitialTurn — so the
  // initial-session path finds it resolved.
  if (bootstrapSession && (process.env.KORTIX_SESSION_ID ?? '').trim()) {
    void claimInitialTurn()
      .then(() => {
        if (bootState.timeline.some((mark) => mark.label === 'initial-turn-claimed')) return
        bootMark('initial-turn-claimed')
      })
      .catch((err) => {
        logger.warn('[boot] early initial-turn claim failed; the session path retries', {
          err: err instanceof Error ? err.message : String(err),
        })
      })
  }

  // Learn the CURRENT managed lineup from the gateway this session bills
  // against, concurrently with the repo clone. The managed set is deployment
  // config and the image's baked catalog goes stale the moment it changes, so
  // without this a managed model added after the last template build is absent
  // from OpenCode's provider map and every turn on it dies with
  // `ModelNotFound: kortix/<id>` (prod incident 2026-08-19). The result is
  // consumed by buildOpencodeConfigContent at spawn; the clone is the boot
  // long-pole, so the fetch costs no critical-path time.
  startManagedModelsPrefetch(process.env.KORTIX_LLM_BASE_URL, process.env.KORTIX_TOKEN)

  // Fresh-boot acquisition goes through the config-provider coordinator
  // (git | prefer-s3 | require-s3, see src/services/config-provider). In `git` mode this
  // is materializeRepo's exact behaviour, split across the coordinator's warm
  // check and the Git transport.
  const repoMaterializePromise: Promise<string | null> = cfg.autoClone
    ? materializeProject(cfg, {
        bootMark,
        onSummary: (summary) => {
          bootState.configProvider = summary
        },
      })
        .then(async (result) => {
          // A prepared-S3 start already has the exact working tree; the
          // optional history backfill waits for real readiness (see
          // runDeferredHistoryBackfill) instead of competing with the runtime
          // spawn for CPU and the proxied Git path.
          if (result.provider === 's3') {
            // …and after the blob-pack import has settled, so the two never
            // write packs into the same object store at once.
            const hydration = result.hydration ?? Promise.resolve()
            bootState.deferredHistoryBackfill = () => {
              void hydration.then(
                () => scheduleHistoryBackfill(cfg, cfg.projectTarget),
                () => scheduleHistoryBackfill(cfg, cfg.projectTarget),
              )
            }
          }
          bootMark('repo-materialized')
          // Pin the credential helper repo-locally now the repo exists, so
          // `git push` authenticates whatever the invoking shell's HOME is.
          // Part of materialization, not a step after readiness: the agent can
          // push the moment the gate opens.
          await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((err) => {
            logger.warn('[boot] repo-local git credential helper setup failed', {
              err: err instanceof Error ? err.message : String(err),
            })
          })
          return null
        })
        .catch((err) => {
          bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
          logger.error('[boot] repo materialization failed', err)
          return bootState.repoMaterializationError
        })
    : Promise.resolve(null)

  // Every gateway session routes OpenCode through the localhost LLM proxy.
  // Start it before either compiled-config or checkout-config OpenCode can
  // spawn, so both boot paths receive the same provider base URL.
  if (
    hasKortixLlmGateway(process.env) &&
    !process.env.KORTIX_LLM_PROXY_URL &&
    process.env.KORTIX_LLM_PROXY_DISABLE !== '1'
  ) {
    const llmPort = Number(process.env.KORTIX_LLM_PROXY_PORT) || 4319
    const llmUrl = startLlmProxy(llmPort, process.env.KORTIX_LLM_BASE_URL, process.env.KORTIX_TOKEN)
    if (llmUrl) {
      process.env.KORTIX_LLM_PROXY_URL = llmUrl
      bootMark('llm-proxy-started')
      logger.info('[boot] llm proxy up; opencode provider routes through it', { llmUrl })
    }
  }

  // ── The ONE boot path ───────────────────────────────────────────────────
  // Everything about what OpenCode runs lives in `bootOpenCodeConfig`: the
  // early spawn, the flag answer, the candidates, the proof, the readiness
  // gate. Nothing here decides a config dir, and nothing here opens the gate.
  const activeConfig = await bootOpenCodeConfig({
    cfg,
    opencode,
    workspace: repoMaterializePromise,
    mark: bootMark,
    start: async () => {
      await opencode.start()
      if (opencode.getPid() !== null) bootMark('opencode-spawned')
      // Resolve only once the process can be TALKED to. The proof is the first
      // request this box sends, and a request to a bound-but-handlerless port
      // is never answered: it burned its whole 2 s timeout plus a 500 ms poll
      // on every boot (measured 2026-09-24, +2.0 s to opencode-ready).
      await opencode.waitForCurrentListening()
    },
    respawn: async () => {
      await opencode.restart({ finalizeTurn: false }).catch((err) => {
        logger.warn('[boot] opencode.restart() rejected', { err: (err as Error).message })
      })
      await opencode.waitForCurrentListening()
    },
    refresh: async () => {
      const reloaded = await harness.configuration.reloadForWorkspace()
      if (reloaded) bootMark('opencode-workspace-reloaded')
      return reloaded
    },
    onReady: () => {
      bootState.workspaceReady = true
    },
  })
  logger.info('[boot] resolved opencode config dir', {
    opencodeConfigDir: activeConfig.dir,
    source: activeConfig.source,
    releaseId: activeConfig.releaseId,
    proven: activeConfig.proven,
    fallbackReason: activeConfig.fallbackReason,
  })

  // The boot clone is shallow; restore history in the background now that the
  // workspace is usable, so `git log`/`blame`/`diff` work without ever having
  // been on the critical path.
  if (cfg.autoClone && !bootState.repoMaterializationError && !bootState.deferredHistoryBackfill) {
    scheduleHistoryBackfill(cfg, cfg.projectTarget)
  }
  if (bootState.repoMaterializationError) {
    logger.warn('[boot] skipping runtime readiness because repo materialization failed')
  }

  // If the image shipped without its baked catalog, opencode just booted on the
  // minimal model set (see loadGatewayCatalog). Repair the file in the
  // background so the next opencode start has the full picker — deliberately
  // AFTER the spawn and without a restart, because the whole point is that a
  // ~400KB cross-region catalog fetch never gates a session boot again.
  if (catalogIsDegraded(process.env.KORTIX_LLM_CATALOG_FILE)) {
    scheduleCatalogWarm(process.env.KORTIX_LLM_BASE_URL, process.env.KORTIX_TOKEN)
  }

  logger.info('[boot] proxy up; runtime bootstrap complete', {
    servicePort: cfg.servicePort,
  })

  if (bootState.repoMaterializationError) return

  // Project-declared boot command (`sandbox.on_boot`), backgrounded now that the
  // repo is materialized and the proxy is up. Host-owned: see src/harness/shared/on-boot.ts.
  runSandboxOnBoot(cfg)

  // Warm-SEED builder boot (autoClone but NO session): this VM is booted by
  // Platinum's stateful-capture machinery to be snapshotted fully warm — repo
  // cloned, opencode up. Forked sessions land their real env (KORTIX_SESSION_ID,
  // tokens, branch) in /etc/pt-env via the host's reconfigure; the snapshot
  // resumes THIS process, so it must adopt that env itself: without this the
  // fork keeps the seed's baked tokens and stays on the default branch (caught
  // live 2026-06-10 — forks answered health on `main` with the deriving
  // session's credentials). Become capture-ready here, but leave the session
  // runtime (initial session + event relay) to the adopting session.
  if ((process.env.KORTIX_SESSION_ID ?? '').trim() === '' && cfg.autoClone) {
    void (async () => {
      // Keep waiting as long as the platform's capture budget plausibly
      // allows — a single bounded wait (20s) missed opencode by 4 seconds
      // once and the seed then NEVER wrote its pin, so every capture of that
      // template aborted at its 240s budget forever (caught live 2026-06-11).
      const deadline = Date.now() + 5 * 60_000
      let ok = false
      while (!ok && Date.now() < deadline) {
        ok = await waitForOpencodeReady(opencode, cfg.projectTarget)
      }
      if (!ok) {
        logger.warn('[seed] opencode never became ready; capture will not trigger')
        return
      }
      bootMark('opencode-ready')
      // Pre-create the root opencode session and pin it, so forks' backend
      // ensure-opencode resolves 'healed' off the listed session instead of
      // paying opencode's first-session project init (~2s) on the chat-ready
      // path. The capture condition requires the pin file, so the snapshot is
      // guaranteed to contain this session.
      try {
        const session = await createInitialOpenCodeSession(
          opencode,
          process.env.KORTIX_WORKSPACE || '/workspace',
        )
        if (session.id) {
          // Marker BEFORE the pin: the snapshot capture gates on the pin file
          // existing, so writing the marker first guarantees every fork that
          // inherits the pin also inherits the marker (else it can't rotate).
          markSeedBakedSession(session.id)
          writeOpenCodeSessionPin(session.id)
          bootMark('seed-opencode-session')
          logger.info('[seed] pre-created root opencode session', { sessionId: session.id })
        }
      } catch (err) {
        logger.warn('[seed] root opencode session pre-create failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
      logger.info('[seed] capture-ready; awaiting session adoption', { timeline: bootState.timeline })
    })()
    armSeedAdoption(harness, server, bootState, bootMark, startSessionRuntime)
    return
  }

  void startSessionRuntime(harness, cfg, bootState, bootMark)
}

// Post-opencode session runtime: create the initial opencode session (when a
// prompt/bootstrap was requested) and start the question-relay event loop.
// Shared post-boot session runtime: create the initial opencode session when
// requested and wire the question/turn event relay.
// Once per daemon process. A second call is a no-op even if a second runtime
// start happens (seed boot then fork adoption), so a box can never restart
// OpenCode twice for the same reason.
let managedReconcileRan = false

/**
 * Run the history backfill a prepared-S3 start deferred until the runtime is
 * ACTUALLY ready (both readiness exits call this; the first one wins). A Git
 * start schedules its backfill right after materialization as before.
 */
function runDeferredHistoryBackfill(bootState: SandboxBootState): void {
  const run = bootState.deferredHistoryBackfill
  if (!run) return
  bootState.deferredHistoryBackfill = null
  run()
}

/**
 * Post-spawn managed-model reconcile — the OFF-CRITICAL-PATH half of "the
 * sandbox learns the managed set from the API it talks to".
 *
 * The config build (buildOpencodeConfigContent) is synchronous by rule: it uses
 * only what is already known, because `opencode serve` cannot bind its port
 * until that file is written — awaiting the fetch there cost 1.6s of a 6.5s dev
 * boot. So the live answer is applied HERE instead, after the spawn and before
 * the initial prompt is delivered:
 *
 *   - settle the prefetch started at proxy-up (its own ≤5s budget, started at
 *     ~80ms — by the time OpenCode is spawning this is already resolved, so it
 *     costs ~0ms and runs concurrently with OpenCode's own cold start);
 *   - diff the live managed set against the provider map OpenCode actually
 *     booted with;
 *   - only a genuinely MISSING managed id — the model that would answer
 *     `ModelNotFound` — buys one controlled restart. The bundled managed table
 *     ships with every release, so the common case is a no-op.
 *
 * Never restarts across a live turn: `opencodeTurnInFlight` treats "cannot
 * tell" as busy, and a cold box with no pin answers a definite `false` without
 * a request.
 */
/** Test seam: re-arm the once-per-process guard. */
export function resetManagedReconcileForTests(): void {
  managedReconcileRan = false
}

export async function reconcileManagedModels(
  opencode: Opencode,
  cfg: Config,
  bootMark: (label: string) => void,
  // Test seams only — production always uses these defaults. The session
  // catalog file lives under the daemon's own home (never `env.HOME`, see
  // KORTIX_OPENCODE_CONFIG_PATH), and the live-turn probe is the real one.
  opts: {
    catalogTargetFile?: string
    turnProbe?: (baseUrl: string, workspace: string) => Promise<boolean | null>
  } = {},
): Promise<void> {
  if (managedReconcileRan) return
  managedReconcileRan = true
  const startedAt = Date.now()
  try {
    // Free in wall-clock terms: OpenCode is cold-starting in its OWN process
    // (4.7-12s spawn→answering) while this waits, and the very next boot step
    // blocks on that anyway. The prefetch's own ≤5s budget started at proxy-up,
    // so it is normally already settled when this runs.
    const live = await settleManagedModelsPrefetch()
    if (!live) {
      logger.info('[boot] managed reconcile: no live managed set; bundled managed models stand', {
        ms: Date.now() - startedAt,
      })
      return
    }
    const missing = missingManagedModelIds(live)
    if (missing.length === 0) {
      logger.info('[boot] managed reconcile: opencode already has every managed model', {
        managed: Object.keys(live).length,
        ms: Date.now() - startedAt,
      })
      return
    }
    const probe = opts.turnProbe ?? opencodeTurnInFlight
    const turnInFlight = await probe(opencode.getInternalUrl(), cfg.workspace)
    if (turnInFlight !== false) {
      logger.warn('[boot] managed reconcile: skipping restart — a turn is live or unreadable', {
        missing,
        turnInFlight,
        ms: Date.now() - startedAt,
      })
      return
    }
    const written = writeManagedOverlayCatalogFile({
      currentCatalogFile: process.env.KORTIX_LLM_CATALOG_FILE ?? '/opt/kortix/llm-catalog.json',
      targetCatalogFile:
        opts.catalogTargetFile ?? `${OPENCODE_HOME}/.config/kortix-llm-catalog.session.json`,
      managed: live,
    })
    if (written) process.env.KORTIX_LLM_CATALOG_FILE = written
    // OpenCode materializes provider models at process start, so the file alone
    // changes nothing for the process that is already running.
    await opencode.restart()
    const ready = await waitForOpencodeReady(opencode, cfg.projectTarget)
    logger.info('[boot] managed reconcile: restarted opencode with the missing managed models', {
      missing,
      managed: Object.keys(live).length,
      catalogFile: written,
      ready,
      ms: Date.now() - startedAt,
    })
  } catch (err) {
    logger.warn('[boot] managed reconcile failed; boot continues on the configured catalog', {
      err: err instanceof Error ? err.message : String(err),
      ms: Date.now() - startedAt,
    })
  } finally {
    bootMark('managed-reconcile')
  }
}

/**
 * One convergence once OpenCode is ready. It proves a release spawned at
 * boot and moves the box onto the desired release. Detached: it never delays readiness. A swap waits while
 * a turn runs; the API converges again at turn end. The seed-adoption path
 * reaches this through `startSessionRuntime`, so it converges once after
 * adoption.
 */
function scheduleConvergenceAfterReady(opencode: Opencode, cfg: Config, bootMark: (label: string) => void): void {
  void convergeConfigRelease({
    cfg,
    opencode,
    turnInFlight: () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace),
  })
    .then((response) => {
      logger.info('[boot] config convergence after ready', {
        outcome: response.outcome,
        releaseId: response.config.release_id,
        source: response.config.source,
        reason: response.reason,
      })
      if (response.config.source === 'release' && response.config.proven) bootMark('config-release-proven')
    })
    .catch((err) => {
      if (err instanceof ConvergeBusyError) return
      logger.warn('[boot] config convergence after ready failed', { err: String(err) })
    })
}

/**
 * What every runtime-ready exit of `startSessionRuntime` owes the control
 * plane. Both exits (initial session, plain readiness) call this one function,
 * so neither can drop a step.
 */
function runtimeReadyTail(
  opencode: Opencode,
  cfg: Config,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): void {
  // Persist the in-guest timeline now that this boot is complete — see
  // boot-timeline-relay.ts. Fire-and-forget and once-guarded.
  relayBootTimelineToApi(bootState.timeline)
  runDeferredHistoryBackfill(bootState)
  // The boot push: the projection exists server-side from the moment the box
  // is usable, so a cold session answers its roster from Postgres.
  scheduleRuntimeProjectionPush('boot')
  scheduleRuntimeAssetsReconcile(cfg)
  scheduleConvergenceAfterReady(opencode, cfg, bootMark)
  // the runtime-convergence contract (PR #7785), Rule 3: convergence must keep running
  // for as long as this box is alive, not only once at boot. Both readiness
  // exits call `runtimeReadyTail` (this function's own doc, above), including
  // warm-fork adoption, so this always wires the CURRENT opencode/cfg;
  // `wireRuntimeTruth`'s ticker is idempotent (a second call here — a second
  // adoption on the same process — does not stack a second interval).
  wireRuntimeTruth(cfg, opencode)
}

async function startSessionRuntime(
  harness: OpenCodeHarnessService,
  cfg: Config,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): Promise<void> {
  const opencode = harness.native
  const instanceGuard = harness.instanceGuard
  instanceGuard.configure({
    canWarm: () => opencode.getState() === 'ok' && bootState.workspaceReady !== false,
  })
  const markOpencodeListening = () => {
    if (bootState.timeline.some((mark) => mark.label === 'opencode-listening')) return
    bootMark('opencode-listening')
  }
  // BEFORE the event loop, the root resolution and any prompt delivery: a
  // restart here strands nothing, and the first turn must run on a provider map
  // that has every managed model the picker offers.
  await reconcileManagedModels(opencode, cfg, bootMark)
  // One relay for every harness (shared/audit-relay.ts). A spool an older
  // daemon left behind is renamed first, or loading it would fail the runtime.
  const auditSpoolPath = resolveOpenCodeAuditSpoolPath(process.env)
  try {
    migratePreW3AuditSpool(auditSpoolPath)
  } catch (err) {
    logger.warn('[opencode-events] pre-W3 audit spool migration failed', { err: (err as Error).message })
  }
  const auditRelay = createRuntimeAuditRelay('opencode', auditSpoolPath)
  const flushAuditRelay = () => {
    logger.info('[opencode-events] audit relay volume', auditRelay.stats())
    void auditRelay.stop().catch((error) =>
      logger.warn('[opencode-events] audit relay shutdown flush failed', {
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  process.once('SIGTERM', flushAuditRelay)
  process.once('SIGINT', flushAuditRelay)
  const onEvent = (event: { type?: string; properties?: unknown }) => {
    // Fan out BEFORE the audit relay: the sequencer and the state projection
    // are what the product reads, and neither may be starved by a relay that
    // is spooling to disk. Both swallow their own faults; the try/catch here
    // only guarantees an unexpected throw cannot break the audit path that
    // follows, which IS allowed to mark the runtime unhealthy.
    try {
      publishOpenCodeEvent(kortixEventBus(), event)
      runtimeStateStore()?.noteEvent(event)
      // A catalog-moving frame re-pushes the projection (debounced, etag-gated).
      if (event.type && CATALOG_MOVING_EVENT_TYPES.has(event.type)) {
        scheduleRuntimeProjectionPush(event.type)
      }
      // A disposed instance is rebuilt lazily by its next request. Make that
      // request the daemon's own, so no prompt is the first caller of a cache.
      if (event.type === 'server.instance.disposed' || event.type === 'global.disposed') {
        instanceGuard.noteInstanceDisposed()
        void instanceGuard.warm(event.type)
      }
    } catch (error) {
      logger.warn('[opencode-events] runtime fan-out failed', {
        err: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      auditRelay.enqueue(event)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bootState.auditRelayError = message
      logger.error('[opencode-events] audit relay persistence failed; runtime is unhealthy', {
        err: message,
      })
    }
  }
  const onQuestionAsked = (req: RuntimeQuestionRequest) => {
    void relayQuestionToApi(req, cfg, opencode).catch((err) =>
      logger.warn('[opencode-events] question relay failed', { err: (err as Error).message }),
    )
  }
  // Report only: apps/api pushes "needs your approval". The permission itself
  // stays open for the user (shared/turn-relay.ts `relayPermission`).
  const onPermissionAsked = (req: RuntimePermissionRequest) => {
    void relayPermission(req).catch((err) =>
      logger.warn('[opencode-events] permission relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionIdle = (opencodeSessionId: string) => {
    void (async () => {
      // An aborted turn is checked first: it may have been healed and resumed,
      // and then it has not ended (instance-guard.ts).
      const verdict = await instanceGuard.inspectEndedTurn(opencodeSessionId)
      if (verdict.kind === 'unrequested' && verdict.resumed) return
      kortixEventBus().publishDaemon(
        'kortix.turn',
        { opencode_session_id: opencodeSessionId, verdict: 'idle' },
        opencodeSessionId,
      )
      await relayTurnEndToApi(opencodeSessionId, 'idle', opencode, cfg, unrequestedAbortCause(verdict))
      // THE SAFE BOUNDARY. A turn has just finished, so this is the one moment
      // the box knows nothing is running — the only moment a daemon swap costs a
      // reconnect instead of a lost turn. Converge and apply here, not on a
      // timer: a timer near a readiness decision is what the config-releases AST
      // tripwires forbid. `applyStagedAssetsIfIdle` re-asks the turn oracle
      // anyway, so a CHILD session going idle under a live root turn is refused.
      convergeRuntimeAssetsAtTurnEnd(cfg)
      // Same boundary, same reasoning, for a config-affecting `/kortix/env`
      // restart `applyEnvironment` deferred while this turn (or an earlier
      // one) was running. A no-op when nothing is pending.
      await retryDeferredOpencodeEnvRestart(opencode, cfg.workspace)
    })().catch((err) =>
      logger.warn('[opencode-events] turn-end relay failed', { err: (err as Error).message }),
    )
  }
  // Auto-resume ROOT turns killed by a TRANSIENT provider/stream error — a
  // stalled model host mid-stream ("Upstream idle timeout exceeded"), a reset,
  // a 5xx after opencode's own retries. Instead of surfacing a dead red turn,
  // the turn is re-prompted to continue. Budget-limited (3 per 15min per
  // session) with growing backoff; permanent errors, subagent sessions, staged
  // reverts and exhausted budget fall through and surface exactly as before.
  // See turn-auto-resume.ts. This wiring was LOST in the ACP-runtime refactor
  // churn (the module survived, its call site did not — #4152 first added it),
  // so every transient provider error had been surfacing raw.
  const autoResumer = createTurnAutoResumer({
    opencode,
    cfg,
    isRoot: (sid) => isRootOpencodeSession(sid, opencode, cfg),
  })
  instanceGuard.configure({
    isRoot: (sid) => isRootOpencodeSession(sid, opencode, cfg),
    resumeVictim: (sid, view) =>
      autoResumer.maybeResume(
        sid,
        { name: view.errorName ?? 'MessageAbortedError', message: 'Aborted' },
        { cause: 'runtime-fault' },
      ),
  })
  const onSessionError = (opencodeSessionId: string, error?: OpencodeTurnError) => {
    void (async () => {
      // A successful resume means the turn is being re-prompted to continue, so
      // it must NOT surface as the turn's final outcome — neither on the event
      // bus nor in the API ledger. maybeResume returns false when the error is
      // not resumable → relay it exactly as before this feature.
      if (await autoResumer.maybeResume(opencodeSessionId, error)) return
      // The same for an abort nobody asked for (instance-guard.ts).
      const verdict = await instanceGuard.inspectEndedTurn(opencodeSessionId)
      if (verdict.kind === 'unrequested' && verdict.resumed) return
      error = unrequestedAbortCause(verdict) ?? error
      kortixEventBus().publishDaemon(
        'kortix.turn',
        { opencode_session_id: opencodeSessionId, verdict: 'error', error: error ?? null },
        opencodeSessionId,
      )
      await relayTurnEndToApi(opencodeSessionId, 'error', opencode, cfg, error)
    })().catch((err) =>
      logger.warn('[opencode-events] turn-end relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionStatus = (opencodeSessionId: string, statusType: string) => {
    if (statusType !== 'busy' && statusType !== 'retry') return
    void relayTurnBeginAfterInitialAcceptance({
      initialAcceptancePending: initialTurnAcceptancePending,
      reconcileInitialAcceptance: reconcileInitialTurnAcceptance,
      relayTurnBegin: () => relayTurnBeginToApi(opencodeSessionId, opencode, cfg),
    }).catch((err) =>
      logger.warn('[opencode-events] turn-begin relay failed', { err: (err as Error).message }),
    )
  }
  let initialTurnAcceptanceSettled = false
  const initialTurnAcceptancePending = () =>
    !initialTurnAcceptanceSettled && initialTurnClaim() !== null
  let initialTurnAcceptanceInFlight = false
  const reconcileInitialTurnAcceptance = async () => {
    if (initialTurnAcceptanceSettled || initialTurnAcceptanceInFlight) return
    const opencodeSessionId = bootState.initialRuntimeSessionId
    const turnToken = initialTurnClaim()?.turnToken
    const messageId = initialTurnClaim()?.messageId
    if (!opencodeSessionId || !turnToken || !messageId) return
    initialTurnAcceptanceInFlight = true
    try {
      const result = await reconcileInitialTurnAcceptanceToApi(
        opencode.getInternalUrl(),
        cfg.workspace,
        opencodeSessionId,
        messageId,
        turnToken,
        {
          awaitingPickup:
            bootState.initialPromptDeliveredAtMs != null &&
            Date.now() - bootState.initialPromptDeliveredAtMs < INITIAL_TURN_PICKUP_GRACE_MS,
        },
      )
      // `unknown` grants no authority. Retry it on the next 30-second
      // reconciliation tick. `inactive` means the exact message is absent or
      // terminal, so an older prompt on a reused root cannot promote this token.
      initialTurnAcceptanceSettled = result !== 'unknown'
    } catch (err) {
      logger.warn('[opencode-events] initial turn acceptance relay failed', {
        err: (err as Error).message,
      })
    } finally {
      initialTurnAcceptanceInFlight = false
    }
  }
  // On (re)subscribe, reconcile the pinned root's last turn: if it already
  // COMPLETED (idle) before this subscription was live — the fast-boot race,
  // where a trivial first turn finishes inside the prompt→subscribe gap — relay
  // a synthetic turn-end so the turn still finalizes. Idempotent: relayTurnEnd
  // dedups per completed turn, so the natural session.idle (if it wasn't dropped)
  // and this reconcile collapse to a single finalize; a reconnect after the turn
  // relayed is a no-op.
  const onConnected = () => {
    // A (re)connected stream means an OpenCode process is serving: build its
    // instance caches before any prompt can (instance-guard.ts).
    void instanceGuard.warm('event-stream-connected')
    void reconcileInitialTurnAcceptance()
    void reconcileFinishedFirstTurn(opencode, cfg).catch((err) =>
      logger.warn('[opencode-events] connect reconcile failed', { err: (err as Error).message }),
    )
  }
  const eventHandlers = {
    onEvent,
    onQuestionAsked,
    onPermissionAsked,
    onSessionIdle,
    onSessionError,
    onSessionStatus,
    onConnected,
    onReconcile: onConnected,
  }
  let loopStarted = false
  if (bootState.initialRuntimeSessionRequired) {
    // Start the /event loop before resolving the root and delivering the prompt.
    // Do not await the response headers: OpenCode can withhold them until the
    // first event, which makes an await here deadlock with prompt delivery. The
    // connect reconciliation closes the residual event-loss race.
    harness.events.subscribe(cfg, eventHandlers)
    loopStarted = true
    const completeInitialSessionBoot = async () => {
      // `maybeCreateInitialOpencodeSession` (direct call above, or via
      // `attemptInitialSession` under the retry ladder below) already wrote
      // the id onto `bootState` before this runs — see the `if
      // (bootState.initialRuntimeSessionId)` / `established()` guards at
      // both call sites. Re-applying it through the pure helper is what
      // clears a poisoned `initialRuntimeSessionError` from an earlier
      // failed attempt; see `finalizeInitialSession`.
      finalizeInitialSession(bootState, bootState.initialRuntimeSessionId as string)
      await reconcileInitialTurnAcceptance()
      bootMark('initial-turn-accepted')
      opencode.markReady()
      bootMark('opencode-ready')
      logger.info('[boot] opencode ready via initial session', {
        opencodePid: opencode.getPid(),
        timeline: bootState.timeline,
      })
      runtimeReadyTail(opencode, cfg, bootState, bootMark)
    }
    const attemptInitialSession = () =>
      maybeCreateInitialOpencodeSession(
        opencode,
        bootState,
        bootMark,
        markOpencodeListening,
      ).catch((err) => {
        bootState.initialRuntimeSessionError = err instanceof Error ? err.message : String(err)
        logger.warn('[boot] initial opencode session setup failed', err)
      })
    await attemptInitialSession()
    if (bootState.initialRuntimeSessionId) {
      await completeInitialSessionBoot()
      return
    }
    // NOT established — a `defer` (opencode slow to answer, prior root pinned)
    // or a claim/setup failure. Until 2026-08-26 this was a dead end: nothing
    // ever retried, `runtimeReady` stayed false forever, the proxy 503'd every
    // request `initial_runtime_session_pending`, and the session spun "Waking
    // the agent" until a human clicked Restart (reported session, 10+ min).
    // The runtime is unusable without the root, so retry until established —
    // bounded interval, detached so the rest of boot (readiness probe, event
    // loop fallback below) proceeds and the box stays observable meanwhile.
    void retryUntilInitialSessionEstablished({
      attempt: attemptInitialSession,
      established: () => bootState.initialRuntimeSessionId !== null,
      finalize: completeInitialSessionBoot,
    })
  }
  const ready = await waitForOpencodeReady(opencode, cfg.projectTarget, markOpencodeListening)
  if (ready) {
    bootMark('opencode-ready')
    logger.info('[boot] opencode ready', { opencodePid: opencode.getPid(), timeline: bootState.timeline })
    runtimeReadyTail(opencode, cfg, bootState, bootMark)
    // Only start the loop if the initial-session branch didn't already (avoids a
    // duplicate subscription when the initial session was requested but failed).
    if (!loopStarted) harness.events.subscribe(cfg, eventHandlers)
  } else {
    logger.warn('[boot] opencode did not become ready within deadline; lifecycle still retrying', { opencodePid: opencode.getPid() })
  }
}


/** Concrete session model from KORTIX_OPENCODE_MODEL.
 *
 * Gateway mode exposes one OpenCode provider (`kortix`). Its model ids are the
 * complete gateway wire refs, including nested refs such as
 * `codex/gpt-5.6-sol` and `anthropic/claude-sonnet-4-6`. Gateway overrides must
 * therefore keep the complete wire ref as `modelID` instead of treating its
 * first segment as an OpenCode provider.
 *
 * Gateway-disabled sessions keep the native `provider/model` split. Bare
 * legacy Zen ids remain normalized onto the native OpenCode provider. */
/** Claim warm-seed boot before the host considers monitor or session mode. */
export async function runOpenCodeWarmSeed(context: HarnessBootContext & { cfg: Config; bootState: SandboxBootState }): Promise<boolean> {
  if ((process.env.KORTIX_WARM_SEED ?? '').trim() !== '1') return false
  const { cfg, bootState, bootMark, serve } = context
  registerOpenCodeStateReader()
  await runWarmSeedMode(cfg, bootState, bootMark, serve, startSessionRuntime)
  return true
}
