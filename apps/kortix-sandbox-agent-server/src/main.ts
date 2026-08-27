import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from './agent-env-file'
import { dispatchCli, isManagementSubcommand } from './cli'
import { loadConfig, resolveOpencodeConfigDir, resolveSandboxOnBoot, type Config } from './config'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  materializeRepo,
  materializeScaffoldSeed,
  materializeProjectSeed,
  runGitCredentialHelper,
  scheduleHistoryBackfill,
} from './git'
import { enableDaemonLogFile, logger } from './logger'
import { MonitorRunner, parseMonitorSpecs } from './monitor-runner'
import {
  catalogIsDegraded,
  createOpencodeSupervisor,
  hasKortixLlmGateway,
  OPENCODE_HOME,
  missingManagedModelIds,
  refreshGatewayCatalogFile,
  scheduleCatalogWarm,
  settleManagedModelsPrefetch,
  startManagedModelsPrefetch,
  writeManagedOverlayCatalogFile,
  waitForOpencodeReady,
  type Opencode,
} from './opencode'
import { relayBootTimelineToApi } from './boot-timeline-relay'
import { scheduleRuntimeProjectionPush } from './runtime-projection-relay'
import { repairOpencodeConfigDir } from './apple-double'
import { ensureOpencodeConfigDeps } from './opencode-config-deps'
import { ensureInjectedManagedSkills } from './injected-skills'
// Converge `/usr/local/bin/kortix` + the managed-skill overlay on the API this
// sandbox talks to. Called at BOTH of `startSessionRuntime`'s readiness exits —
// which is also the warm-fork adoption path, since `adopt()` ends in
// `startSessionRuntime` — so every way a session comes up reconciles once.
// Strictly AFTER `bootMark('opencode-ready')` and never awaited: it adds zero
// milliseconds to the readiness the API and the frontend poll for.
import { configureRuntimeConvergence, scheduleRuntimeAssetsReconcile } from './runtime-assets'
import { isSharedSeedBakedRoot, OPENCODE_SEED_BAKED_PIN_PATH } from './opencode-fork-root'
import { startOpencodeEventLoop, flattenOpencodeError, type QuestionRequest, type OpencodeTurnError } from './opencode-events'
import { kortixEventBus } from './kortix-event-bus'
import { runtimeStateStore } from './runtime-state-projection'
import { auditRelayConfigFromEnv, auditRelayToken, createAuditRelay } from './opencode-audit-relay'
import { observeIdleForRunaway } from './runaway-turn-guard'
import {
  OPENCODE_SESSION_PIN_PATH,
  resolveOpenCodeAuditSpoolPath,
  writeOpenCodeSeedBakedPin,
  writeOpenCodeSessionPin,
} from './runtime-state'
import { createProjectEnvStore } from './project-env'
import { startEgressShim } from './egress-shim'
import { startProxy } from './proxy'
import {
  startLlmProxy,
  setLlmProxyToken,
  llmProxyReady,
  llmProxyBaseUrl,
  startConnectorProxy,
  setConnectorProxyToken,
  connectorProxyReady,
  connectorProxyBaseUrl,
} from './llm-proxy'
import type { SandboxBootState } from './routes/health'
import { installShutdownHandlers } from './shutdown'
import { startStaticWebServer } from './static-web'
import { opencodeDeliveryInFlight, opencodeTurnInFlight } from './opencode-turn-state'
import { installCompiledRuntime } from './compiled-runtime'

const LEGACY_OPENCODE_ZEN_FREE_MODELS = new Set([
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
])

interface InitialTurnClaim {
  prompt: string
  turnToken: string
  messageId: string
}

let claimedInitialTurn: InitialTurnClaim | null = null

/** Test seam: a daemon process claims at most one initial turn. */
export function resetClaimedInitialTurnForTests(): void {
  claimedInitialTurn = null
}

async function main() {
  const bootTime = Date.now()
  const cfg = loadConfig()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  const bootState: SandboxBootState = {
    repoMaterializationError: null,
    timeline: [],
    initialOpenCodeSessionRequired: bootstrapSession,
    initialOpenCodeSessionId: null,
    initialOpenCodeSessionError: null,
  }
  // In-container boot timeline (ms since process start). Surfaced via
  // /kortix/health so the dashboard can attribute post-create boot latency.
  const bootMark = (label: string) => {
    const atMs = Date.now() - bootTime
    bootState.timeline.push({ label, atMs })
    // Boot phases ride the SAME sequenced stream as OpenCode's own frames
    // (`/kortix/opencode/events`). A client watching a cold box learns
    // "repo materialized" / "opencode ready" in order with everything else,
    // instead of inferring it from a health poll's shape.
    kortixEventBus().publishDaemon('kortix.boot', { label, at_ms: atMs })
  }
  // The daemon's own log lands on the box from the first line (logger.ts):
  // under E2B stdout goes to envd and is not on disk, which is why the
  // 2026-08-25 port desync could be fenced but never proven.
  const daemonLog = enableDaemonLogFile()
  logger.info('[boot] kortix-sandbox-agent-server starting', {
    servicePort: cfg.servicePort,
    opencodeInternalPort: cfg.opencodeInternalPort,
    opencodeStandbyPort: cfg.opencodeStandbyPort,
    staticPort: cfg.staticPort,
    autoClone: cfg.autoClone,
    pid: process.pid,
    bun: typeof Bun !== 'undefined' ? Bun.version : null,
    daemonLogFile: daemonLog.path,
  })

  // Bring the static web server up first. It only serves files off disk, so it
  // has no dependency on repo materialization or opencode — starting it early
  // means previews work even while the agent is still booting, and a repo/
  // opencode failure never takes it down. Reachable via /proxy/<staticPort>.
  const staticWeb = startStaticWebServer(cfg.staticPort)
  bootMark('static-web')

  // Warm snapshot seed capture. This boots a session-less runtime, warms
  // opencode, writes the capture pin, and later adopts the forked session env
  // written by Platinum restore.
  if ((process.env.KORTIX_WARM_SEED ?? '').trim() === '1') {
    await runWarmSeedMode(cfg, bootTime, bootState, bootMark, staticWeb)
    return
  }

  // Monitor box (docs/specs/2026-08-12-monitors.md D4). Same daemon, same
  // image, same repo checkout — but it supervises the project's monitor
  // processes instead of opencode, and never starts an LLM at all.
  if (cfg.workload === 'monitor') {
    await runMonitorMode(cfg, bootTime, bootState, bootMark, staticWeb)
    return
  }

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
  // secret; see src/egress-shim/index.ts.
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
  // The supervisor is created here with the BAKED config dir because the
  // project's own dir lives inside the repo and isn't known yet; it is
  // reconfigured with the resolved dir below, before the process is ever
  // spawned. `reconfigure` only rewrites state read at spawn time, so this is
  // exactly equivalent to constructing it late.
  const opencodeBinaryPrefetchEnabled = process.env.KORTIX_OPENCODE_BINARY_PREFETCH === '1'
  const opencode = createOpencodeSupervisor(cfg, cfg.defaultOpencodeConfigDir, projectEnv, {
    onStartupMark: bootMark,
    onFirstReadyResponse: () => {
      if (bootState.timeline.some((mark) => mark.label === 'opencode-session-api-ready')) return
      bootMark('opencode-session-api-ready')
    },
    nativeBinaryFastPathEnabled: opencodeBinaryPrefetchEnabled,
  onUnplannedRespawn: () => {
      // opencode died on its own and is back. Close whatever turn it was
      // writing, or the client streams a part that will never complete.
      const pinned = readPinnedOpencodeSessionId()
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
  })
  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  const shutdown = installShutdownHandlers(opencode, server, staticWeb)
  // Hand the convergence machinery this session's live runtime, once.
  //
  // Two things need it. opencode convergence restarts opencode, so it goes
  // through the supervisor that owns spawn/respawn/dispose — never behind its
  // back. And a staged daemon update exits `75` through the SAME clean shutdown
  // a SIGTERM takes: opencode is a child of this process, so a bare
  // `process.exit` would leave the relaunched daemon fighting an orphan for the
  // opencode port.
  configureRuntimeConvergence({
    seam: {
      // Re-read per pass: a verified reload promotes the replacement on the
      // other half of the port pair, so the live URL moves.
      opencodeBaseUrl: () => opencode.getInternalUrl(),
      workspace: cfg.workspace,
      restartOpencode: () => opencode.restart(),
    },
    turnInFlight: () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace),
    exit: (code) => shutdown({ reason: 'agent-swap', exitCode: code }),
  })
  bootMark('proxy-up')

  // Learn the CURRENT managed lineup from the gateway this session bills
  // against, concurrently with the repo clone. The managed set is deployment
  // config and the image's baked catalog goes stale the moment it changes, so
  // without this a managed model added after the last template build is absent
  // from OpenCode's provider map and every turn on it dies with
  // `ModelNotFound: kortix/<id>` (prod incident 2026-08-19). The result is
  // consumed by buildOpencodeConfigContent at spawn; the clone is the boot
  // long-pole, so the fetch costs no critical-path time.
  startManagedModelsPrefetch(process.env.KORTIX_LLM_BASE_URL, process.env.KORTIX_TOKEN)

  // Platinum lazily faults image pages into a fresh VM. Read the OpenCode
  // executable sequentially while repository and config work run. Stop at the
  // spawn boundary, so a slow page fault cannot extend the critical path.
  const opencodeBinaryPrefetchPromise =
    opencodeBinaryPrefetchEnabled
      ? opencode.prefetchBinary()
      : Promise.resolve(false)

  const repoMaterializePromise: Promise<void> = cfg.autoClone
    ? materializeRepo(cfg).catch((err) => {
        bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
        logger.error('[boot] repo materialization failed', err)
      })
    : Promise.resolve()

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

  const compiledOpencodeConfigDir = (process.env.KORTIX_COMPILED_OPENCODE_CONFIG_DIR ?? '').trim()
  const hasCompiledOpencodeConfig =
    compiledOpencodeConfigDir.length > 0 &&
    (existsSync(join(compiledOpencodeConfigDir, 'opencode.jsonc')) ||
      existsSync(join(compiledOpencodeConfigDir, 'opencode.json')))
  let opencodeStartedFromCompiledConfig = false
  const compiledOpencodeStartPromise: Promise<void> | null = hasCompiledOpencodeConfig
    ? (async () => {
        await ensureOpencodeConfigDeps(compiledOpencodeConfigDir)
        await ensureInjectedManagedSkills(compiledOpencodeConfigDir)
        bootMark('compiled-config-deps')
        opencode.cancelBinaryPrefetch()
        opencode.reconfigure(cfg, compiledOpencodeConfigDir, projectEnv)
        await opencode.start()
        opencodeStartedFromCompiledConfig = opencode.getPid() !== null
        if (opencodeStartedFromCompiledConfig) bootMark('opencode-spawned')
      })().catch((err) => {
        logger.warn('[boot] compiled-config OpenCode start failed; using checkout fallback', {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    : null

  // Wait for the clone to finish before we let downstream code (config-dir
  // resolution, readiness probe, initial session creation) think the workspace
  // is ready.
  await repoMaterializePromise
  bootMark('repo-materialized')
  await compiledOpencodeStartPromise

  // The boot clone is shallow; restore history in the background now that the
  // workspace is usable, so `git log`/`blame`/`diff` work without ever having
  // been on the critical path.
  if (cfg.autoClone && !bootState.repoMaterializationError) {
    scheduleHistoryBackfill(cfg, cfg.projectTarget)
  }

  const opencodeConfigDir = await resolveOpencodeConfigDir(cfg)
  logger.info('[boot] resolved opencode config dir', {
    opencodeConfigDir,
    usingProjectConfig: opencodeConfigDir !== cfg.defaultOpencodeConfigDir,
  })
  if (!opencodeStartedFromCompiledConfig) {
    await ensureOpencodeConfigDeps(opencodeConfigDir)
    await ensureInjectedManagedSkills(opencodeConfigDir)
    bootMark('config-deps')
  } else if (opencodeConfigDir !== compiledOpencodeConfigDir) {
    // Prepare the checked-out directory for the next runtime restart without
    // delaying this session's readiness. The current process uses the exact
    // same revision from the verified tmpfs capsule.
    void Promise.all([
      ensureOpencodeConfigDeps(opencodeConfigDir),
      ensureInjectedManagedSkills(opencodeConfigDir),
    ]).catch((err) => {
      logger.warn('[boot] checked-out OpenCode config background preparation failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // Repository/config work defines the free overlap window. Stop any
  // remaining sequential read here so prefetch cannot outlive either outcome.
  opencode.cancelBinaryPrefetch()
  void opencodeBinaryPrefetchPromise

  if (bootState.repoMaterializationError) {
    logger.warn('[boot] skipping runtime readiness because repo materialization failed')
    if (opencodeStartedFromCompiledConfig) await opencode.stop()
  } else {
    // Now that the repo exists, pin the credential helper repo-locally too, so
    // `git push` authenticates regardless of the invoking shell's HOME (the
    // global config above only applies under HOME=<opencode home>).
    await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((err) => {
      logger.warn('[boot] repo-local git credential helper setup failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
    // Reconfigure now so any later restart uses the checked-out config. The
    // already-running compiled-config process stays untouched.
    opencode.reconfigure(cfg, opencodeConfigDir, projectEnv)
    if (!opencodeStartedFromCompiledConfig) {
      await opencode.start().catch((err) => {
        logger.warn('[boot] opencode.start() rejected', {
          err: err instanceof Error ? err.message : String(err),
        })
      })
      bootMark('opencode-spawned')
    }
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

  // Project-declared boot command (`[sandbox] on_boot` in kortix.toml), e.g.
  // `pnpm dev` — run it backgrounded once the repo is materialized + the proxy
  // is up, so a session auto-starts its dev stack with zero manual steps. Best
  // effort: a failure here never affects the agent runtime. Output → a log file
  // the agent/user can tail.
  void resolveSandboxOnBoot(cfg)
    .then((onBoot) => {
      if (!onBoot) return
      const logPath = '/var/log/kortix-on-boot.log'
      logger.info('[boot] running [sandbox] on_boot command', { onBoot, logPath })
      try {
        mkdirSync(dirname(logPath), { recursive: true })
      } catch {}
      const out = openSync(logPath, 'a')
      const child = spawn('bash', ['-lc', onBoot], {
        cwd: cfg.projectTarget,
        env: process.env,
        detached: true,
        stdio: ['ignore', out, out],
      })
      child.on('error', (err) =>
        logger.warn('[boot] on_boot command failed to spawn', { err: (err as Error).message }),
      )
      child.unref()
    })
    .catch((err) => logger.warn('[boot] on_boot resolution failed', { err: (err as Error).message }))

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
    armSeedAdoption(opencode, server, bootState, bootMark)
    return
  }

  void startSessionRuntime(opencode, cfg, bootState, bootMark)
}

// Adopt a forked session inside a warm-seed clone. The repo is already baked —
// materializeRepo() takes its local-only branch (remote set-url + `checkout -B
// <session>`), so adoption is ~100ms.
// Trigger: KORTIX_SESSION_ID appearing in /etc/pt-env (the seed's own env
// never contains it — platinum-seed.ts strips it from captureEnv).
function armSeedAdoption(
  opencode: ReturnType<typeof createOpencodeSupervisor>,
  server: ReturnType<typeof startProxy>,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): void {
  let adopted = false
  const adopt = (trigger: string) => {
    if (adopted) return
    adopted = true
    void (async () => {
      const t0 = Date.now()
      reloadSessionEnv()
      const cfg2 = loadConfig()
      // Re-arm the proxy with the session's tokens — the seed booted with the
      // deriving session's credentials, which must never serve this fork.
      server.reload(cfg2)
      bootState.initialOpenCodeSessionRequired =
        (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
      logger.info('[seed] adoption — initializing session', { trigger, branch: process.env.KORTIX_BRANCH_NAME })
      try { await configureGlobalGitIdentity(cfg2, OPENCODE_HOME) } catch {}
      try { await configureGitCredentialHelper(cfg2, OPENCODE_HOME) } catch {}
      if (cfg2.autoClone) {
        await materializeRepo(cfg2).catch((err) => {
          bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
          logger.error('[seed] repo adoption failed', err)
        })
        bootMark('seed-repo-adopted')
        if (!bootState.repoMaterializationError) {
          scheduleHistoryBackfill(cfg2, cfg2.projectTarget)
          await configureRepoCredentialHelper(cfg2, cfg2.projectTarget).catch(() => {})
        }
      }
      await startSessionRuntime(opencode, cfg2, bootState, bootMark)
      logger.info('[seed] adoption complete', { adoptMs: Date.now() - t0, timeline: bootState.timeline })
    })()
  }
  process.on('SIGHUP', () => adopt('sighup'))
  const poll = setInterval(() => {
    let txt = ''
    try { txt = readFileSync('/etc/pt-env', 'utf8') } catch { return }
    if (/^KORTIX_SESSION_ID=\S/m.test(txt)) { clearInterval(poll); adopt('env-poll') }
  }, 250)
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
  opencode: ReturnType<typeof createOpencodeSupervisor>,
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

async function startSessionRuntime(
  opencode: ReturnType<typeof createOpencodeSupervisor>,
  cfg: Config,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): Promise<void> {
  const markOpencodeListening = () => {
    if (bootState.timeline.some((mark) => mark.label === 'opencode-listening')) return
    bootMark('opencode-listening')
  }
  // BEFORE the event loop, the root resolution and any prompt delivery: a
  // restart here strands nothing, and the first turn must run on a provider map
  // that has every managed model the picker offers.
  await reconcileManagedModels(opencode, cfg, bootMark)
  const auditRelay = createAuditRelay(
    async (events) => {
      const ctx = sandboxRelayContext(auditRelayToken(process.env))
      if (!ctx) throw new Error('audit relay context is unavailable')
      const response = await fetch(
        `${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId)}/audit/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(15_000),
        },
      )
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const error = new Error(
          `audit batch rejected: ${response.status} ${body.slice(0, 200)}`,
        ) as Error & { retryAfterMs?: number }
        // 503 + Retry-After is the API telling us this session's audit sequence
        // lock is contended. Honour it instead of hammering the convoy.
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1_000
        throw error
      }
    },
    // Batch size, cadence, the dropped classes and the coalesced classes all
    // come from the environment so an incident can retune the emission
    // contract without a daemon release. See the contract block in
    // opencode-audit-relay.ts.
    {
      spoolPath: resolveOpenCodeAuditSpoolPath(process.env),
      ...auditRelayConfigFromEnv(process.env),
    },
  )
  const auditConfig = auditRelayConfigFromEnv(process.env)
  logger.info('[opencode-events] audit relay emission contract', {
    batchSize: auditConfig.batchSize,
    flushMs: auditConfig.flushMs,
    dropTypes: auditConfig.dropTypes,
    coalesceTypes: auditConfig.coalesceTypes.length,
  })
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
      kortixEventBus().publishOpencode(event)
      runtimeStateStore()?.noteEvent(event)
      // A catalog-moving frame re-pushes the projection (debounced, etag-gated).
      // Same set noteEvent invalidates its catalog on.
      if (
        event.type === 'server.instance.disposed' ||
        event.type === 'mcp.tools.changed' ||
        event.type === 'plugin.added' ||
        event.type === 'global.disposed'
      ) {
        scheduleRuntimeProjectionPush(event.type)
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
  const onQuestionAsked = (req: QuestionRequest) => {
    void relayQuestionToApi(req, cfg, opencode).catch((err) =>
      logger.warn('[opencode-events] question relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionIdle = (opencodeSessionId: string) => {
    kortixEventBus().publishDaemon(
      'kortix.turn',
      { opencode_session_id: opencodeSessionId, verdict: 'idle' },
      opencodeSessionId,
    )
    void relayTurnEndToApi(opencodeSessionId, 'idle', opencode, cfg).catch((err) =>
      logger.warn('[opencode-events] turn-end relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionError = (opencodeSessionId: string, error?: OpencodeTurnError) => {
    kortixEventBus().publishDaemon(
      'kortix.turn',
      { opencode_session_id: opencodeSessionId, verdict: 'error', error: error ?? null },
      opencodeSessionId,
    )
    void relayTurnEndToApi(opencodeSessionId, 'error', opencode, cfg, error).catch((err) =>
      logger.warn('[opencode-events] turn-end relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionStatus = (opencodeSessionId: string, statusType: string) => {
    if (statusType !== 'busy' && statusType !== 'retry') return
    void relayTurnBeginToApi(opencodeSessionId, opencode, cfg).catch((err) =>
      logger.warn('[opencode-events] turn-begin relay failed', { err: (err as Error).message }),
    )
  }
  let initialTurnAcceptanceSettled = false
  let initialTurnAcceptanceInFlight = false
  const reconcileInitialTurnAcceptance = async () => {
    if (initialTurnAcceptanceSettled || initialTurnAcceptanceInFlight) return
    const opencodeSessionId = bootState.initialOpenCodeSessionId
    const turnToken = claimedInitialTurn?.turnToken
    const messageId = claimedInitialTurn?.messageId
    if (!opencodeSessionId || !turnToken || !messageId) return
    initialTurnAcceptanceInFlight = true
    try {
      const result = await reconcileInitialTurnAcceptanceToApi(
        opencode.getInternalUrl(),
        cfg.workspace,
        opencodeSessionId,
        messageId,
        turnToken,
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
    void reconcileInitialTurnAcceptance()
    void reconcileFinishedFirstTurn(opencode, cfg).catch((err) =>
      logger.warn('[opencode-events] connect reconcile failed', { err: (err as Error).message }),
    )
  }
  const eventHandlers = {
    onEvent,
    onQuestionAsked,
    onSessionIdle,
    onSessionError,
    onSessionStatus,
    onConnected,
    onReconcile: onConnected,
  }
  let loopStarted = false
  if (bootState.initialOpenCodeSessionRequired) {
    // Start the /event loop before resolving the root and delivering the prompt.
    // Do not await the response headers: OpenCode can withhold them until the
    // first event, which makes an await here deadlock with prompt delivery. The
    // connect reconciliation closes the residual event-loss race.
    startOpencodeEventLoop(opencode, cfg, eventHandlers)
    loopStarted = true
    const finalizeInitialSession = async () => {
      await reconcileInitialTurnAcceptance()
      opencode.markReady()
      bootMark('opencode-ready')
      logger.info('[boot] opencode ready via initial session', {
        opencodePid: opencode.getPid(),
        timeline: bootState.timeline,
      })
      // Persist the in-guest timeline now that this boot is complete — see
      // boot-timeline-relay.ts. Fire-and-forget and once-guarded.
      relayBootTimelineToApi(bootState.timeline)
      // The boot push: the projection exists server-side from the moment the
      // box is usable, so a cold session answers its roster from Postgres.
      scheduleRuntimeProjectionPush('boot')
      scheduleRuntimeAssetsReconcile(cfg)
    }
    await maybeCreateInitialOpencodeSession(
      opencode,
      bootState,
      bootMark,
      markOpencodeListening,
    ).catch((err) => {
      bootState.initialOpenCodeSessionError = err instanceof Error ? err.message : String(err)
      logger.warn('[boot] initial opencode session setup failed', err)
    })
    const attemptInitialSession = () =>
      maybeCreateInitialOpencodeSession(
        opencode,
        bootState,
        bootMark,
        markOpencodeListening,
      ).catch((err) => {
        bootState.initialOpenCodeSessionError = err instanceof Error ? err.message : String(err)
        logger.warn('[boot] initial opencode session setup failed', err)
      })
    if (bootState.initialOpenCodeSessionId) {
      await finalizeInitialSession()
      return
    }
    // NOT established — a `defer` (opencode slow to answer, prior root pinned)
    // or a claim/setup failure. Until 2026-08-26 this was a dead end: nothing
    // ever retried, `runtimeReady` stayed false forever, the proxy 503'd every
    // request `initial_opencode_session_pending`, and the session spun "Waking
    // the agent" until a human clicked Restart (Essentia ef9f344b, 10+ min).
    // The runtime is unusable without the root, so retry until established —
    // bounded interval, detached so the rest of boot (readiness probe, event
    // loop fallback below) proceeds and the box stays observable meanwhile.
    void retryUntilInitialSessionEstablished({
      attempt: attemptInitialSession,
      established: () => bootState.initialOpenCodeSessionId !== null,
      finalize: finalizeInitialSession,
    })
  }
  const ready = await waitForOpencodeReady(opencode, cfg.projectTarget, markOpencodeListening)
  if (ready) {
    bootMark('opencode-ready')
    logger.info('[boot] opencode ready', { opencodePid: opencode.getPid(), timeline: bootState.timeline })
    relayBootTimelineToApi(bootState.timeline)
    scheduleRuntimeProjectionPush('boot')
    scheduleRuntimeAssetsReconcile(cfg)
    // Only start the loop if the initial-session branch didn't already (avoids a
    // duplicate subscription when the initial session was requested but failed).
    if (!loopStarted) startOpencodeEventLoop(opencode, cfg, eventHandlers)
  } else {
    logger.warn('[boot] opencode did not become ready within deadline; supervisor still retrying', { opencodePid: opencode.getPid() })
  }
}

// Read KEY=VALUE lines from the per-session env file into process.env. Platinum
// restore writes it directly into the guest pre-boot at /etc/pt-env (host-agent
// writeEnvIntoOverlay via debugfs / writeGuestEnv).
function reloadSessionEnv(paths: string[] = ['/etc/pt-env']): void {
  for (const path of paths) {
    let txt: string
    try { txt = readFileSync(path, 'utf8') } catch { continue }
    for (const line of txt.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      const k = t.slice(0, eq)
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) process.env[k] = t.slice(eq + 1)
    }
  }
}

// Warm snapshot seed runtime (opt-in via KORTIX_WARM_SEED=1). Boot opencode +
// the proxy so the VM is snapshottable + health-green, write the root-session
// pin that gates capture, then adopt the forked session's env after Platinum
// restore resumes the captured process.

// Fetch the FULL org model catalog during seed capture and write it to KORTIX_LLM_CATALOG_FILE
// so the seed's opencode config bakes the full picker instead of the
// ~11-model fallback. The seed can't reach the gateway /models (no per-session
// gateway key), so it asks an apps/api endpoint authed by the sandbox token.
// Best-effort + idempotent: a no-op unless KORTIX_LLM_CATALOG_URL is set, and any
// failure just leaves the fallback catalog (LLM + tools still work via proxies).
//
// ENDPOINT CONTRACT (apps/api, to be added deliberately): GET KORTIX_LLM_CATALOG_URL with
// `Authorization: Bearer <KORTIX_TOKEN>` → `{ models: {...} }` ==
// gatewayModelCatalog(projectId, userId). During seed capture there is NO live
// sessionSandboxes row (it's a template build), and the token is a type='user'
// account key, so the route must authorize by validateAccountToken→accountId/projectId,
// NOT by the live-session check used for ordinary sandbox tokens.
async function prefetchSeedCatalog(cfg: Config): Promise<void> {
  const url = process.env.KORTIX_LLM_CATALOG_URL
  if (!url || !cfg.sandboxToken) return
  const file = process.env.KORTIX_LLM_CATALOG_FILE || `${OPENCODE_HOME}/.config/kortix-llm-catalog.json`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.sandboxToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`catalog http ${res.status}`)
  const body = await res.text()
  const parsed = JSON.parse(body) as { models?: Record<string, unknown> }
  const count = parsed.models ? Object.keys(parsed.models).length : 0
  if (count === 0) throw new Error('empty catalog')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body, { mode: 0o600 })
  process.env.KORTIX_LLM_CATALOG_FILE = file
  logger.info('[seed] baked full model catalog for seed', { file, models: count })
}

/**
 * Monitor mode — the box that watches things 24/7
 * (docs/specs/2026-08-12-monitors.md D4).
 *
 * It shares the session boot exactly up to the repo checkout, because monitor
 * commands ARE repo code and need the same working tree an agent gets. From
 * there it diverges completely: no opencode, no LLM, no session. The proxy
 * still binds so /kortix/health answers (the box is otherwise invisible while
 * it is healthy), and MonitorRunner owns everything after that.
 *
 * The repo is checked out at the project's DEFAULT branch: the API omits
 * KORTIX_BRANCH_NAME for a monitor box, so materializeRepo leaves the checkout
 * on default-branch HEAD instead of minting a session branch. A monitor watches
 * what is shipped, not what some session is working on.
 */
async function runMonitorMode(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  staticWeb: ReturnType<typeof startStaticWebServer>,
): Promise<void> {
  const projectEnv = createProjectEnvStore()
  // Monitor processes inherit this process's env (the provider injected the
  // project's runtime secrets there), and the agent env file keeps the same
  // shell contract a session shell has.
  writeAgentEnvFile(projectEnv)

  try {
    await configureGlobalGitIdentity(cfg, OPENCODE_HOME)
    await configureGitCredentialHelper(cfg, OPENCODE_HOME)
  } catch (err) {
    logger.warn('[monitor] git setup failed', { err: err instanceof Error ? err.message : String(err) })
  }
  bootMark('git-identity')

  // The supervisor is constructed but NEVER started — it exists only because
  // the proxy's route table is built around it. /kortix/health answers without
  // touching opencode; every opencode route cleanly 503s, which is the honest
  // answer for a box that has no agent.
  const opencode = createOpencodeSupervisor(cfg, cfg.defaultOpencodeConfigDir, projectEnv, {
    onStartupMark: bootMark,
  })
  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(opencode, server, staticWeb)
  bootMark('proxy-up')

  if (cfg.autoClone) {
    await materializeRepo(cfg).catch((err) => {
      bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
      logger.error('[monitor] repo materialization failed', err)
    })
  }
  bootMark('repo-materialized')

  const specs = parseMonitorSpecs(cfg.monitorsJson)
  // Fail LOUD and INERT, never crash-loop: the reconciler would just re-create
  // a box that exits, so a misconfigured box stays up, answers health, and says
  // exactly what is wrong.
  if (!cfg.projectId || !cfg.apiUrl || !cfg.sandboxToken) {
    logger.error('[monitor] missing project/API/token env; no monitor will run', {
      hasProjectId: !!cfg.projectId,
      hasApiUrl: !!cfg.apiUrl,
      hasToken: !!cfg.sandboxToken,
    })
    return
  }
  if (!cfg.monitorBoxEpoch) {
    // Without the epoch the server rejects every batch with 409. Running the
    // monitors anyway would burn the box's CPU producing events nothing can
    // accept, so don't.
    logger.error('[monitor] KORTIX_MONITOR_BOX_EPOCH is unset; refusing to run monitors')
    return
  }
  if (specs.length === 0) {
    logger.warn('[monitor] no monitors to run; the box is idle')
    return
  }

  const runner = new MonitorRunner({
    apiUrl: cfg.apiUrl,
    projectId: cfg.projectId,
    token: cfg.sandboxToken,
    boxEpoch: cfg.monitorBoxEpoch,
    monitors: specs,
    cwd: cfg.projectTarget,
  })
  runner.start()
  bootMark('monitors-started')
  // Best-effort drain on shutdown: a SIGTERM'd box should deliver the lines it
  // already captured rather than take them to the grave.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void runner.stop()
    })
  }
}

async function runWarmSeedMode(
  cfg: Config,
  bootTime: number,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  staticWeb: ReturnType<typeof startStaticWebServer>,
): Promise<void> {
  const projectEnv = createProjectEnvStore()
  writeAgentEnvFile(projectEnv)

  // Scaffold-warm the seed: materialize the image-baked scaffold at /workspace
  // (zero-network) so opencode pays its per-directory project init (git scan +
  // file index + LSP + sqlite) ONCE here, FROZEN into the snapshot. Without this
  // every fork paid that ~3.2s init on its own hot path (the runtime-ready
  // wall). Resolve opencode's config from the scaffold's .kortix/opencode so the
  // seed (and every fork) runs the real agents/plugins, not the baked default.
  // Project-scoped warm seed: clone the REAL project repo at base so the
  // captured snapshot already has /workspace. A fork then hits materializeRepo's
  // baked-checkout fast path (no in-box clone). Otherwise use the shared
  // scaffold seed. A failed project clone returns false and degrades to the
  // scaffold seed.
  const projectSeed = !!cfg.repoUrl && (process.env.KORTIX_WARM_SEED_PROJECT_CLONE ?? '').trim() === '1'
  const materialized = projectSeed
    ? await materializeProjectSeed(cfg)
    : await materializeScaffoldSeed(cfg.projectTarget, cfg.defaultBranch)
  bootMark(projectSeed ? 'seed-project-materialized' : 'seed-scaffold-materialized')
  const opencodeConfigDir = materialized
    ? await resolveOpencodeConfigDir(cfg)
    : cfg.defaultOpencodeConfigDir
  await repairOpencodeConfigDir(opencodeConfigDir)
  await ensureOpencodeConfigDeps(opencodeConfigDir).catch(() => {})

  // Warm-fork NO-RESTART path (opt-in KORTIX_LLM_HOTSWAP=1; stateful warm
  // snapshots only — cold + Daytona never run it).
  // Start the localhost LLM credential proxy, and optionally the Connector proxy
  // used by the compatibility MCP face. The agent-facing Connector path is the
  // `kortix connectors` CLI, which reads live env on each shell command and does
  // not need an OpenCode restart. Best-effort: a bind failure leaves the
  // *_PROXY_URL unset and adoption falls back to the restart path where needed.
  const llmHotswap = (process.env.KORTIX_LLM_HOTSWAP ?? '').trim() === '1'
  if (llmHotswap) {
    const llmPort = Number(process.env.KORTIX_LLM_PROXY_PORT) || 4319
    const llmUrl = startLlmProxy(llmPort)
    if (llmUrl) {
      // Seen by buildOpencodeConfigContent (via process.env) at the seed spawn
      // below → provider.kortix routes through the proxy.
      process.env.KORTIX_LLM_PROXY_URL = llmUrl
      bootMark('seed-llm-proxy-started')
      logger.info('[seed] llm hot-swap proxy up; seed bakes proxied gateway provider', { llmUrl })
    }
    const exPort = Number(process.env.KORTIX_CONNECTORS_PROXY_PORT) || 4320
    const exUrl = startConnectorProxy(exPort)
    if (exUrl) {
      // Seen by buildOpencodeConfigContent only when KORTIX_CONNECTORS_MCP_ENABLED=1.
      // The proxy is harmless when unused; the CLI remains the primary path.
      process.env.KORTIX_CONNECTORS_PROXY_URL = exUrl
      bootMark('seed-connector-proxy-started')
      logger.info('[seed] connector hot-swap proxy up for optional connector MCP compatibility', { exUrl })
    }
    // Catalog prefetch (best-effort): the seed is tokenless and can't hit the
    // gateway /models, so fetch the FULL org catalog from an apps/api endpoint
    // authed by the sandbox token and write it to KORTIX_LLM_CATALOG_FILE BEFORE
    // opencode spawns → the seed bakes the FULL model picker, not the ~11-model
    // fallback. No-op unless KORTIX_LLM_CATALOG_URL is wired (see report for the
    // endpoint contract); any failure → fallback models (LLM + tools still work).
    await prefetchSeedCatalog(cfg).catch((err) =>
      logger.warn('[seed] catalog prefetch failed; seed uses fallback models', { err: (err as Error).message }),
    )
  }

  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir, projectEnv, {
    onStartupMark: bootMark,
  onUnplannedRespawn: () => {
      // opencode died on its own and is back. Close whatever turn it was
      // writing, or the client streams a part that will never complete.
      const pinned = readPinnedOpencodeSessionId()
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
  })
  await opencode.start().catch((err) => logger.warn('[seed] opencode.start() rejected', { err: err instanceof Error ? err.message : String(err) }))
  bootMark('seed-opencode-spawned')
  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(opencode, server, staticWeb)
  bootMark('seed-proxy-ready')

  // PRE-WARM before the snapshot: drive opencode's /workspace init to completion
  // and pre-create + pin the root session, so the frozen image has opencode
  // genuinely 'ok' for /workspace AND a listed root session. The platinum
  // capture condition gates on the pin file existing, so the snapshot is taken
  // only AFTER this — making forks resume with runtime-ready instant and the
  // backend ensure resolving 'healed' (no first-session init). Only when a seed
  // (scaffold OR real project repo) materialized; otherwise capture cannot be pinned.
  if (materialized) {
    void (async () => {
      const deadline = Date.now() + 5 * 60_000
      let ok = false
      while (!ok && Date.now() < deadline) ok = await waitForOpencodeReady(opencode, cfg.projectTarget)
      if (!ok) { logger.warn('[seed] opencode never warmed; capture will not trigger'); return }
      bootMark('seed-opencode-ready')
      try {
        const session = await createInitialOpenCodeSession(opencode, cfg.projectTarget)
        if (session.id) {
          // Marker BEFORE the pin: the snapshot capture gates on the pin file
          // existing, so writing the marker first guarantees every fork that
          // inherits the pin also inherits the marker (else it can't rotate).
          markSeedBakedSession(session.id)
          writeOpenCodeSessionPin(session.id)
          bootMark('seed-opencode-session')
          logger.info('[seed] pre-created + pinned root opencode session', { sessionId: session.id })
        }
      } catch (err) {
        logger.warn('[seed] root session pre-create failed', { err: err instanceof Error ? err.message : String(err) })
      }
      logger.info('[seed] capture-ready; awaiting fork adoption', { timeline: bootState.timeline })
    })()
  } else {
    logger.warn('[seed] no seed repo materialized; capture pin will not be written', { timeline: bootState.timeline })
  }

  let adopted = false
  const adopt = (trigger: string) => {
    if (adopted) return
    adopted = true
    void (async () => {
      const t0 = Date.now()
      reloadSessionEnv()
      // The fork's REAL session env has just landed. A warm seed never started
      // an egress shim (runWarmSeedMode returns long before the boot path that
      // does), so a forked session holding a network-boundary secret would
      // otherwise get none — its requests would leave uncredentialed and the
      // upstream 401 would look like a bad secret. Start it here, BEFORE
      // writeAgentEnvFile, because that file is how the proxy + CA variables
      // reach the agent's shells.
      //
      // Deliberately after reloadSessionEnv(): starting earlier would arm the
      // shim with the DERIVING session's token and project id — the same class
      // of bug as the 2026-06-10 incident where forks answered health on main
      // with the deriving session's credentials.
      await startEgressShim()
      writeAgentEnvFile(createProjectEnvStore())
      const cfg2 = loadConfig()
      // Rebuild the proxy/control surface with the fork's cfg; the seed booted
      // tokenless or with seed-only credentials.
      server.reload(cfg2)
      bootState.initialOpenCodeSessionRequired =
        (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
      logger.info('[seed] adopting forked session', { trigger, projectId: cfg2.projectId, autoClone: cfg2.autoClone })
      try { await configureGlobalGitIdentity(cfg2, OPENCODE_HOME) } catch {}
      try { await configureGitCredentialHelper(cfg2, OPENCODE_HOME) } catch {}
      if (cfg2.autoClone) {
        // Clear any seed-clone failure so this retries cleanly. When the seed
        // pre-cloned the project, materializeRepo hits the baked-checkout fast
        // path: set remote + local `git checkout -B <session>` from the cloned
        // base, no network re-clone. Otherwise it clones now.
        bootState.repoMaterializationError = null
        await materializeRepo(cfg2).catch((err) => {
          bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
          logger.error('[seed] repo materialization failed', err)
        })
        bootMark('adopt-repo-materialized')
        if (!bootState.repoMaterializationError) {
          scheduleHistoryBackfill(cfg2, cfg2.projectTarget)
          await configureRepoCredentialHelper(cfg2, cfg2.projectTarget).catch(() => {})
        }
      }

      // The seed opencode process is started before adoption, when it has no
      // session-scoped Connector/CLI/LLM env and may have started before the
      // project config dir exists. Restart it after adopting the fork env + repo so
      // OPENCODE_CONFIG_CONTENT includes the Connector MCP and project config.
      const adoptedOpencodeConfigDir = bootState.repoMaterializationError
        ? cfg2.defaultOpencodeConfigDir
        : await resolveOpencodeConfigDir(cfg2)
      await repairOpencodeConfigDir(adoptedOpencodeConfigDir)
      await ensureOpencodeConfigDeps(adoptedOpencodeConfigDir).catch((err) =>
        logger.warn('[seed] adoption config deps failed', { err: (err as Error).message }),
      )
      // A warm snapshot freezes OpenCode's provider model registry at capture
      // time. Managed/BYOK catalogs can change independently of that snapshot,
      // so refresh from the now-authenticated project gateway before deciding
      // whether the no-restart fast path is safe. OpenCode only reads provider
      // models at process start: a changed catalog requires one controlled
      // restart; an identical catalog keeps the hot-swap path.
      let gatewayCatalogChanged = false
      const llmBaseUrl = process.env.KORTIX_LLM_BASE_URL
      const llmApiKey = process.env.KORTIX_TOKEN
      if (llmBaseUrl && llmApiKey) {
        const currentCatalogFile =
          process.env.KORTIX_LLM_CATALOG_FILE ?? '/opt/kortix/llm-catalog.json'
        const targetCatalogFile = `${OPENCODE_HOME}/.config/kortix-llm-catalog.session.json`
        const refresh = await refreshGatewayCatalogFile({
          currentCatalogFile,
          targetCatalogFile,
          fetchBaseURL: llmBaseUrl,
          fetchApiKey: llmApiKey,
        })
        if (refresh) {
          process.env.KORTIX_LLM_CATALOG_FILE = refresh.catalogFile
          gatewayCatalogChanged = refresh.changed
          if (refresh.changed) bootMark('adopt-gateway-catalog-refreshed')
        }
      }
      // NO-RESTART fast path (opt-in, stateful warm-fork only): the seed baked a
      // session-independent opencode config routed through the localhost LLM +
      // connector proxies, so inject the per-session tokens LIVE and reuse the
      // already-warm opencode — skipping the ~8s restart. Engages only when
      // hot-swap is on, the LLM proxy is up + the seed baked the proxied provider
      // (KORTIX_LLM_PROXY_URL set), opencode is currently healthy, and the repo
      // materialized cleanly. Anything missing falls through to restart.
      let hotSwapped = false
      if (
        llmHotswap &&
        !!process.env.KORTIX_LLM_PROXY_URL &&
        llmProxyBaseUrl() != null &&
        opencode.getState() === 'ok' &&
        !gatewayCatalogChanged &&
        !bootState.repoMaterializationError
      ) {
        // LLM gateway: required for the session to function.
        setLlmProxyToken(process.env.KORTIX_TOKEN, process.env.KORTIX_LLM_BASE_URL)
        // Optional Connector MCP compatibility: if the seed enabled that face,
        // the running MCP points at this proxy. The CLI path does not need this;
        // it reads the live session env through BASH_ENV on every command.
        if (process.env.KORTIX_CONNECTORS_PROXY_URL && connectorProxyBaseUrl() != null) {
          setConnectorProxyToken(process.env.KORTIX_TOKEN, process.env.KORTIX_API_URL)
        }
        if (llmProxyReady()) {
          hotSwapped = true
          bootMark('adopt-opencode-hotswapped')
          // Observability only: this confirms the optional connector proxy has a
          // live token. It does not assert that OpenCode registered MCP tools.
          if (connectorProxyReady()) bootMark('adopt-connector-proxy-ready')
          logger.info('[seed] fork adoption hot-swap: per-session tokens injected via proxies, opencode not restarted', {
            connectorReady: connectorProxyReady(),
            gatewayCatalogChanged,
          })
        }
      }
      if (!hotSwapped) {
        opencode.reconfigure(cfg2, adoptedOpencodeConfigDir, projectEnv)
        await opencode.restart().catch((err) =>
          logger.warn('[seed] adoption opencode restart failed', { err: (err as Error).message }),
        )
        bootMark('adopt-opencode-restarted')
      }
      await startSessionRuntime(opencode, cfg2, bootState, bootMark)
      logger.info('[seed] fork adoption complete', { adoptMs: Date.now() - t0, hotSwapped, timeline: bootState.timeline })
    })()
  }
  process.on('SIGHUP', () => adopt('sighup'))
  const poll = setInterval(() => {
    let txt = ''
    try { txt = readFileSync('/etc/pt-env', 'utf8') } catch { return }
    if (/^KORTIX_API_URL=\S/m.test(txt)) { clearInterval(poll); adopt('env-poll:/etc/pt-env') }
  }, 200)
}

// Establish the session's canonical opencode root and (once) deliver the
// initial prompt. IDEMPOTENT across daemon/opencode restarts: a restart (e.g.
// the daemon OOM-killed during a heavy install, then relaunched by the runtime)
// re-runs this. The old version unconditionally POSTed a NEW root and
// re-delivered the whole prompt — leaving the pre-restart root orphaned
// mid-turn (a `bash[running]` part that never completes) and the task running
// twice. That orphan, plus a null DB pin, is exactly what stranded the web +
// Slack on a dead turn (the 2026-06-15 spinner incident). Now we:
//   1. REUSE the existing canonical root if opencode already holds one
//      (pin file → else most-recently-active root, mirroring the server),
//   2. abort an interrupted turn on the reused root so its stream finalizes
//      instead of spinning forever, and
//   3. deliver the initial prompt at most once (only to a root with no
//      messages yet) — never re-running a task whose side effects already ran.
// It also reports the canonical root to apps/api so the durable DB pin is set
// server-side at bootstrap, with no dependency on a browser ever opening it.
//
// T12: (1) and (3) above both trusted a message-list read that can
// itself fail — non-2xx, or the 5s timeout a cold post-resume opencode
// routinely hits — collapsing "could not tell" into "no messages", which
// re-delivers `prompt` into a live conversation. `RootInspection.known` closes
// that: an unconfirmed read never delivers and never counts as orphaned (see
// `initialPromptAlreadyDelivered`, `isTurnStillOrphaned`). Separately, a
// `waitForRootList` timeout with a prior pin no longer falls through to
// creating (and pinning) a brand-new root — see `resolveExistingRoot`'s
// `defer` outcome — which was the SAME spinner-incident shape one layer up:
// timeout read as "no roots" instead of "opencode is just slow".
//
// T22: `hasMessages` alone is not enough. OpenCode's `session.revert` is a
// STAGED pointer — nothing is deleted until the next prompt, from ANY
// producer, commits the truncation. A commit can truncate the reused root
// all the way back to zero messages, and `initialPromptAlreadyDelivered`
// reads that exactly like "never delivered" — re-running `prompt` (the
// original task kickoff) into a session the user was mid-rewind on. A prior
// pin for this sandbox is stronger evidence than message count: it proves
// `maybeCreateInitialOpencodeSession` already ran to a delivery decision on
// this box before, so an empty transcript behind an existing pin means
// truncation, not "never delivered". See the `priorPin` check below.
/** Retry delay for the initial-session claim: 5s, 10s, …, capped at 30s. */
export function initialSessionRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * Math.max(attempt, 1), 30_000)
}

/**
 * Re-run the initial-session setup until the root is established, then run
 * `finalize` exactly once. `maybeCreateInitialOpencodeSession` is idempotent
 * (it re-resolves the pinned root and keeps deferring while opencode has not
 * answered), so retrying is safe; without the root the runtime can never turn
 * ready, so the loop has no attempt cap — only a capped interval. Exported for
 * tests; see initial-session-retry.test.ts.
 */
export async function retryUntilInitialSessionEstablished(input: {
  attempt: () => Promise<unknown>
  established: () => boolean
  finalize: () => Promise<void>
  delayMs?: (attempt: number) => number
  sleep?: (ms: number) => Promise<void>
  /** Tests only: stop after this many attempts. */
  maxAttempts?: number
}): Promise<boolean> {
  const delayMs = input.delayMs ?? initialSessionRetryDelayMs
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  for (let attempt = 1; input.maxAttempts === undefined || attempt <= input.maxAttempts; attempt++) {
    await sleep(delayMs(attempt))
    if (input.established()) break
    logger.warn('[boot] initial opencode session still pending; retrying', { attempt })
    await input.attempt()
    if (input.established()) break
  }
  if (!input.established()) return false
  await input.finalize()
  return true
}

async function maybeCreateInitialOpencodeSession(
  opencode: Opencode,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  onListening?: () => void,
): Promise<void> {
  const claimedTurn = await claimInitialTurnFromApi()
  const prompt = claimedTurn?.prompt ?? ''
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  if (!prompt && !bootstrapSession) return

  const workspace = process.env.KORTIX_WORKSPACE || '/workspace'

  // `opencode-session-created` used to be ONE mark covering opencode's entire
  // cold start plus every bootstrap round-trip — 4.7s (Daytona) / 12.0s
  // (Platinum) at p50, and completely unattributable. These sub-marks split it:
  //   opencode-answering  → opencode's own cold start (runtime + config +
  //                         provider init + per-directory project init)
  //   opencode-root-ready → resolving/creating this session's root
  //   opencode-session-created (existing) → first prompt delivered
  // A big opencode-answering means the fix is in the image (pre-booted
  // opencode); a big root-ready means it's our bootstrap.
  // Captured BEFORE this boot writes its own pin below, so it reflects only
  // what a PRIOR boot of this sandbox left behind — see the T22 note above.
  const priorPin = readPinnedOpencodeSessionId()
  // F1: likewise captured BEFORE this boot could possibly write its own
  // marker (delivery, below, hasn't happened yet) — reflects only a PRIOR
  // boot's successful delivery, never this one's own pending write.
  const priorDeliveredMarker = readInitialPromptDeliveredMarker()
  const fastRootReadinessEnabled = process.env.KORTIX_OPENCODE_BINARY_PREFETCH === '1'
  const rootListDeadlineMs = await waitForFastOpencodeRootReadiness({
    fastPathEnabled: fastRootReadinessEnabled,
    firstReadyResponse: opencode.waitForCurrentReadyResponse(),
  })
  // A verified reload can promote OpenCode onto the standby port while the
  // readiness gate waits. Resolve the live URL after that wait so root lookup
  // never resumes against the retired process.
  const baseUrl = opencode.getInternalUrl()
  const resolved = await resolveExistingRoot(
    baseUrl,
    workspace,
    priorPin,
    rootListDeadlineMs,
    onListening,
    fastRootReadinessEnabled,
  )
  bootMark('opencode-answering')
  if (resolved.status === 'defer') {
    // opencode never answered the root list within the deadline, and a prior
    // root IS pinned — see `resolveExistingRoot`'s `defer` outcome. Creating
    // (and pinning) a fresh root here would risk orphaning that conversation
    // under a competing one — the exact 2026-06-15 spinner-incident shape (see
    // the comment above this function). Leave `bootState.initialOpenCodeSessionId`
    // unset and return: boot falls through to the `waitForOpencodeReady`
    // fallback path below instead of the initial-session fast path, and
    // nothing here touches the existing root or delivers `prompt` anywhere.
    logger.warn(
      '[boot] deferring initial opencode session setup — opencode did not answer in time and a prior root is pinned',
    )
    return
  }
  let existing = resolved.status === 'found' ? resolved.root : null
  // Warm-fork de-collision: a CoW-forked sandbox inherits the snapshot's single
  // pinned root, so `existing` here is the SHARED seed root — every fork would
  // otherwise resolve the same opencode session id and their chats bleed together
  // (the client keys all message state by that id). Rotate onto a fresh
  // per-session root EXACTLY ONCE by ignoring the seed root here; the marker is
  // retired below so later restarts reuse THIS fork's own root via the path above.
  const seedBakedId = readSeedBakedSessionId()
  const rotateOffSeedRoot = isSharedSeedBakedRoot(existing?.id, seedBakedId)
  if (rotateOffSeedRoot) {
    logger.info('[boot] fork is on the shared seed-baked root; rotating to its own', { seedBakedId })
    existing = null
  }
  let sessionId: string
  let alreadyDelivered = false
  if (existing) {
    sessionId = existing.id
    alreadyDelivered = reusedRootAlreadyDelivered(existing, priorPin, priorDeliveredMarker)
    logger.info('[boot] reusing existing opencode root', {
      sessionId,
      alreadyDelivered,
      priorPin: priorPin !== null,
      known: existing.known,
      lastTurnIncomplete: existing.lastTurnIncomplete,
      lastTurnHasError: existing.lastTurnHasError,
    })
    // A turn interrupted by the restart left a part stuck "running"; finalize it
    // so a client streaming this root sees the turn end instead of spinning. A
    // turn that already carries `info.error` was already finalized by a prior
    // abort (see `isTurnStillOrphaned`) — re-aborting it here is exactly the
    // repeated-abort-on-every-boot bug this guard exists to prevent.
    if (
      isTurnStillOrphaned(existing) &&
      (await confirmTurnOrphaned(baseUrl, workspace, sessionId, existing))
    ) {
      await abortOpencodeTurn(baseUrl, workspace, sessionId)
    }
    bootMark('runtime-session-resume-requested')
  } else {
    logger.info('[boot] creating initial opencode session', {
      bytes: prompt.length,
      hasPrompt: prompt.length > 0,
      workspace,
    })
    bootMark('runtime-session-new-requested')
    const session = await createInitialOpenCodeSession(opencode, workspace)
    if (!session.id) throw new Error('opencode session create returned no id')
    sessionId = session.id
  }

  pinOpencodeSessionFile(sessionId)
  if (rotateOffSeedRoot) {
    // This fork now owns `sessionId` (pinned above): retire the one-shot marker
    // and drop the orphaned shared seed root (best-effort — the pin is
    // authoritative, so cleanup failing never reintroduces the collision).
    clearSeedBakedMarker()
    if (seedBakedId && seedBakedId !== sessionId) {
      void deleteOpencodeSession(baseUrl, workspace, seedBakedId)
    }
  }
  bootMark('opencode-root-ready')
  // Set the durable DB pin server-side now — Slack/trigger/cron sessions that no
  // browser ever opens otherwise kept a null pin, which forced a lazy resolution
  // that could land on the wrong root.
  void relayBootstrapPinToApi(sessionId)

  if (prompt && !alreadyDelivered) {
    await publishInitialOpenCodeSessionAfterPrompt(bootState, sessionId, () =>
      deliverInitialOpenCodePrompt(
        opencode,
        sessionId,
        workspace,
        buildInitialPromptBody(prompt, claimedTurn?.messageId),
      ),
    )
    // F1: written ONLY after delivery actually succeeded (an exception above
    // skips this line) — the durable receipt `reusedRootAlreadyDelivered`
    // trusts unconditionally on every later boot of this sandbox.
    markInitialPromptDelivered()
    logger.info('[boot] initial prompt delivered', { sessionId })
  } else if (prompt) {
    bootState.initialOpenCodeSessionId = sessionId
    logger.info('[boot] initial prompt already delivered to reused root; not re-running', {
      sessionId,
    })
  } else {
    bootState.initialOpenCodeSessionId = sessionId
    logger.info('[boot] opencode root ready (bootstrap, no prompt)', { sessionId })
  }
  bootMark('opencode-session-created')
}

/**
 * Publish the boot root only after OpenCode accepts the initial prompt.
 *
 * The event-loop reconciliation timer reads `initialOpenCodeSessionId` as its
 * acceptance gate. Publishing the id before `prompt_async` returns lets that
 * timer promote a `delivering` database record while the request is still in
 * flight, including before OpenCode has received one byte.
 */
export async function publishInitialOpenCodeSessionAfterPrompt(
  bootState: SandboxBootState,
  sessionId: string,
  deliver: () => Promise<void>,
): Promise<void> {
  await deliver()
  bootState.initialOpenCodeSessionId = sessionId
}

/**
 * End a turn that lost the process writing it.
 *
 * A turn ends only when opencode emits `session.idle`/`session.error`. A killed
 * or crashed opencode emits neither, so the last assistant message stays
 * incomplete and every client streaming it spins — indefinitely, because the
 * supervisor's respawn brings the box back without ever closing that turn.
 *
 * Boot already did exactly this when it adopted a root whose last turn never
 * finished; it was simply unreachable from anywhere else. Same two calls, now
 * callable after an unplanned respawn as well.
 *
 * Best-effort by construction: if opencode is not answering yet, or the abort
 * fails, we log and move on. A stuck spinner is bad; a daemon that cannot
 * finish booting because it could not tidy up a turn is worse.
 */
export async function finalizeOrphanedTurn(
  baseUrl: string,
  workspace: string,
  sessionId: string,
): Promise<boolean> {
  const inspection = await inspectRoot(baseUrl, workspace, sessionId)
  if (!inspection.known) {
    // Could not read this root's message state at all — see
    // `RootInspection.known`. Never treat "could not tell" as orphaned.
    logger.warn('[boot] could not read root message state; not treating turn as orphaned', { sessionId })
    return false
  }
  // Covers both "the turn already finished" and "the turn already carries an
  // error from a prior finalize" — see `isTurnStillOrphaned`. The latter is
  // what makes this idempotent across repeated boots/respawns over the same
  // stuck turn: an already-errored turn is never re-aborted.
  if (!isTurnStillOrphaned(inspection)) return false
  // Never abort a turn that is merely still being written — see
  // confirmTurnOrphaned. This is the difference between closing a turn its
  // opencode took to the grave and interrupting one that was about to finish.
  if (!(await confirmTurnOrphaned(baseUrl, workspace, sessionId, inspection))) return false
  await abortOpencodeTurn(baseUrl, workspace, sessionId)
  return true
}

/** Best-effort write of the canonical opencode root id to the well-known pin
 *  file (the in-sandbox source of truth read by abort/relay/turn-end). */
function pinOpencodeSessionFile(sessionId: string): void {
  try {
    writeOpenCodeSessionPin(sessionId)
  } catch (err) {
    logger.warn('[boot] failed to pin opencode session id', err)
  }
}

/**
 * F1: durable proof that `deliverInitialOpenCodePrompt` actually SUCCEEDED —
 * not just that boot intended to deliver it. `OPENCODE_SESSION_PIN_PATH` is
 * written BEFORE delivery (see `pinOpencodeSessionFile` above, called ahead
 * of the delivery call at this function's call site). A daemon crash after
 * that write can leave the pin behind but never deliver. A bare-pin check
 * alone would then read every future boot as "already delivered". That would
 * silence the session forever.
 * (see `reusedRootAlreadyDelivered`). This marker is written ONLY after
 * `deliverInitialOpenCodePrompt` returns successfully, right next to the pin,
 * so its mere existence is the delivery receipt the pin alone can't provide.
 */
const OPENCODE_INITIAL_PROMPT_DELIVERED_PIN_PATH = join(
  dirname(OPENCODE_SESSION_PIN_PATH),
  'opencode-initial-prompt-delivered',
)

/** Best-effort read of the F1 delivery marker. False (never true-by-accident)
 *  on any read failure — the same "unknown reads never skip delivery" bias as
 *  the rest of this gate; see `reusedRootAlreadyDelivered`. */
function readInitialPromptDeliveredMarker(): boolean {
  try {
    return existsSync(OPENCODE_INITIAL_PROMPT_DELIVERED_PIN_PATH)
  } catch {
    return false
  }
}

/** Best-effort write of the F1 delivery marker. Directory already exists by
 *  the time this runs — `pinOpencodeSessionFile` (called earlier in the same
 *  boot) already created it. */
function markInitialPromptDelivered(): void {
  try {
    writeFileSync(OPENCODE_INITIAL_PROMPT_DELIVERED_PIN_PATH, '1', { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    logger.warn('[boot] failed to write initial-prompt-delivered marker', err)
  }
}

/** Record (at seed time) that the pinned root is the SEED's pre-baked one, so the
 *  first claiming fork rotates off it instead of sharing it. Captured into the
 *  snapshot next to the pin, so every fork inherits it. See opencode-fork-root.ts. */
function markSeedBakedSession(sessionId: string): void {
  try {
    writeOpenCodeSeedBakedPin(sessionId)
  } catch (err) {
    logger.warn('[seed] failed to write seed-baked session marker', err)
  }
}

function readSeedBakedSessionId(): string | null {
  try {
    if (!existsSync(OPENCODE_SEED_BAKED_PIN_PATH)) return null
    const id = readFileSync(OPENCODE_SEED_BAKED_PIN_PATH, 'utf8').trim()
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** One-shot: a fork has taken its OWN root, so retire the marker — later daemon
 *  restarts then reuse the fork's root via the normal idempotent reuse path. */
function clearSeedBakedMarker(): void {
  try {
    if (existsSync(OPENCODE_SEED_BAKED_PIN_PATH)) unlinkSync(OPENCODE_SEED_BAKED_PIN_PATH)
  } catch (err) {
    logger.warn('[boot] failed to clear seed-baked marker', err)
  }
}

/** Best-effort delete of the orphaned shared seed root after a fork rotates onto
 *  its own. Correctness does NOT depend on this (the fork pins + relays its own
 *  id); it just stops the empty shared root from lingering in the session list. */
async function deleteOpencodeSession(baseUrl: string, workspace: string, sessionId: string): Promise<void> {
  try {
    await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(workspace)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3_000) },
    )
  } catch {
    /* orphan is harmless — the fork's own pinned root is authoritative */
  }
}

interface ExistingRoot {
  id: string
  hasMessages: boolean
  lastTurnIncomplete: boolean
  /** See `RootInspection.lastTurnHasError` — an errored turn is already
   *  finalized and must not be re-aborted. */
  lastTurnHasError: boolean
  /** Carried through so the orphan re-check can tell the same unfinished turn
   *  from a different one that started since. */
  lastMessageId: string | null
  /** See `RootInspection.known` — false when the read that produced the rest
   *  of this shape failed. `hasMessages`/`lastTurnIncomplete`/`lastTurnHasError`
   *  are meaningless in that case (all defaulted `false`); callers must branch
   *  on `known` before trusting them. */
  known: boolean
}

/** What `resolveExistingRoot` learned, and what the caller may safely do about
 *  it — see the function doc for the three outcomes. Exported for tests. */
export type ExistingRootResult =
  | { status: 'found'; root: ExistingRoot }
  | { status: 'create' }
  | { status: 'defer' }

const OPENCODE_ROOT_RESOLUTION_DEADLINE_MS = 20_000
const OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS = 5_000
const OPENCODE_FIRST_READY_GATE_MAX_MS = OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS

type FastOpencodeRootReadinessInput = {
  fastPathEnabled: boolean
  firstReadyResponse: Promise<void>
  deadlineMs?: number
}

type FastOpencodeRootReadinessDeps = {
  now?: () => number
  waitForSignal?: (signal: Promise<void>, timeoutMs: number) => Promise<void>
}

async function waitForSignalOrTimeout(signal: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Hold the optional FAST root lookup for the supervisor's first successful
 * session-API response. The gate replaces at most one doomed five-second
 * root-list request. Its elapsed time is deducted from the existing 20-second
 * root-resolution budget, so it cannot extend boot. The unchanged resolver
 * still owns retries, root selection, and found/create/defer decisions.
 */
export async function waitForFastOpencodeRootReadiness(
  input: FastOpencodeRootReadinessInput,
  deps: FastOpencodeRootReadinessDeps = {},
): Promise<number> {
  const deadlineMs = Math.max(0, input.deadlineMs ?? OPENCODE_ROOT_RESOLUTION_DEADLINE_MS)
  if (!input.fastPathEnabled) return deadlineMs

  const now = deps.now ?? Date.now
  const waitForSignal = deps.waitForSignal ?? waitForSignalOrTimeout
  const startedAt = now()
  await waitForSignal(
    input.firstReadyResponse,
    Math.min(deadlineMs, OPENCODE_FIRST_READY_GATE_MAX_MS),
  )
  const elapsedMs = Math.max(0, now() - startedAt)
  return Math.max(0, deadlineMs - elapsedMs)
}

/**
 * Resolve a usable existing canonical root for this workspace so a restart
 * reuses it instead of creating a duplicate. Prefers the pinned id (if it still
 * exists as a root), else the most-recently-active root.
 *
 * Three outcomes:
 *   - `found`  — a root exists. `root.known` says whether its message state
 *     could actually be read (see `ExistingRoot.known`).
 *   - `create` — opencode answered and genuinely holds no root, OR opencode
 *     never answered within the deadline AND nothing is pinned (a pinless
 *     cold boot — there is no conversation to orphan). Safe to create the
 *     first root, same as before.
 *   - `defer`  — opencode never answered the root list within the deadline
 *     AND a prior root IS pinned. Creating (and pinning) a fresh root here
 *     would risk orphaning that conversation under a competing one — opencode
 *     may just be slow (a cold post-resume opencode routinely takes longer
 *     than this deadline). The caller must not create or pin anything; see
 *     the 2026-06-15 spinner-incident comment above
 *     `maybeCreateInitialOpencodeSession`. T12.
 *
 * `priorPin`/`rootListDeadlineMs` default to the real pin file / 20s deadline
 * in production and are overridable so tests can exercise the `defer` branch
 * without a 20s wait or a real pin file — same pattern as
 * `opencodeTurnInFlight` in opencode-turn-state.ts.
 */
async function resolveExistingRoot(
  baseUrl: string,
  workspace: string,
  priorPin: string | null = readPinnedOpencodeSessionId(),
  rootListDeadlineMs = 20_000,
  onListening?: () => void,
  strictAttemptDeadline = false,
): Promise<ExistingRootResult> {
  // Wait for a DEFINITIVE answer from opencode before deciding. Treating a slow
  // boot as "no roots" would create a duplicate on restart — the exact bug we're
  // killing — so only conclude "create a fresh root" once opencode has actually
  // answered with an empty list (or never answers within the deadline, and
  // there is no prior pin to protect — see `defer` above).
  const roots = await waitForRootList(
    baseUrl,
    workspace,
    rootListDeadlineMs,
    onListening,
    strictAttemptDeadline,
  )
  if (!roots) {
    if (priorPin) {
      logger.warn(
        '[boot] opencode did not answer the root list within the deadline; a prior root is pinned — deferring instead of creating a competing root',
        { priorPin },
      )
      return { status: 'defer' }
    }
    return { status: 'create' }
  }
  if (roots.length === 0) return { status: 'create' }
  const pinned = priorPin ? roots.find((r) => r.id === priorPin) : undefined
  const chosen = pinned || pickMostRecentRoot(roots)
  if (!chosen) return { status: 'create' }
  const inspection = await inspectRoot(baseUrl, workspace, chosen.id)
  return {
    status: 'found',
    root: {
      id: chosen.id,
      hasMessages: inspection.hasMessages,
      lastTurnIncomplete: inspection.lastTurnIncomplete,
      lastTurnHasError: inspection.lastTurnHasError,
      lastMessageId: inspection.lastMessageId,
      known: inspection.known,
    },
  }
}
// Exported (via a trailing statement, not an inline `export` keyword) so the
// text `async function resolveExistingRoot(` stays intact for
// orphan-finalize-error-idempotent.test.ts's source-text assertion, which
// locates `maybeCreateInitialOpencodeSession`'s body by searching for exactly
// that string.
export { resolveExistingRoot }

interface RootLite { id: string; created: number; updated: number }

/** Poll opencode's session list until it answers definitively (reachable),
 *  returning the roots it holds (possibly `[]`). Null only if opencode never
 *  became reachable within the deadline — so the caller never mistakes a slow
 *  boot for an empty workspace and creates a duplicate root. */
async function waitForRootList(
  baseUrl: string,
  workspace: string,
  deadlineMs = 20_000,
  onListening?: () => void,
  strictAttemptDeadline = false,
): Promise<RootLite[] | null> {
  const deadline = Date.now() + deadlineMs
  let listeningSeen = false
  const markListening = () => {
    if (listeningSeen) return
    listeningSeen = true
    onListening?.()
  }
  while (Date.now() < deadline) {
    const attemptTimeoutMs = strictAttemptDeadline
      ? Math.min(
          OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS,
          Math.max(1, deadline - Date.now()),
        )
      : OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS
    const roots = await listOpencodeRoots(
      baseUrl,
      workspace,
      markListening,
      attemptTimeoutMs,
    )
    if (roots !== null) return roots
    const retryDelayMs = strictAttemptDeadline
      ? Math.min(100, Math.max(0, deadline - Date.now()))
      : 100
    if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs))
  }
  return null
}

/** List opencode ROOT sessions (no parentID), newest-updated first. Returns null
 *  when opencode is not reachable yet — distinct from `[]` (reachable, no
 *  sessions).
 *
 *  `roots=true` makes the SERVER drop child sessions instead of us paging every
 *  session in the workspace and filtering. Probed on the real binaries
 *  2026-08-20: `roots`, `limit`, `start`, `search` and `scope` are all declared
 *  on `GET /session` in 1.17.11 AND 1.18.19, and both answered
 *  `?roots=true&limit=1` with exactly the most-recently-updated ROOT out of
 *  three roots plus one newer child. Boxes provisioned before today still run
 *  1.17.11, so that parity is the reason this is safe to ship as one call.
 *
 *  `limit=1` is deliberately NOT used, and the client-side `!parentID` filter
 *  deliberately stays:
 *   - `resolveExistingRoot` prefers the PINNED root over the newest one, which
 *     needs the pin to be findable in this list — `limit=1` would hide it and
 *     silently re-canonicalize a live conversation onto a different root.
 *   - An OpenCode that does not know a query parameter ignores it silently. If
 *     `roots` were ever dropped, the filter is what still stops a Task-tool
 *     CHILD from being adopted as the canonical root. One line, absolute. */
async function listOpencodeRoots(
  baseUrl: string,
  workspace: string,
  onHttpResponse?: () => void,
  attemptTimeoutMs = OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS,
): Promise<RootLite[] | null> {
  try {
    const res = await fetch(
      `${baseUrl}/session?directory=${encodeURIComponent(workspace)}&roots=true`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      },
    )
    onHttpResponse?.()
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ id?: string; parentID?: string | null; time?: { created?: number; updated?: number } }>
    if (!Array.isArray(data)) return []
    return data
      .filter((s) => s.id && !s.parentID)
      .map((s) => ({ id: s.id as string, created: s.time?.created ?? 0, updated: s.time?.updated ?? s.time?.created ?? 0 }))
  } catch {
    return null
  }
}

/** Most-recently-active root, tie-broken by newest-created then id. Kept in sync
 *  with the server's pickCanonicalRoot (opencode-session-resolver.ts) so the
 *  sandbox and the API converge on the SAME canonical root. */
function pickMostRecentRoot(roots: RootLite[]): RootLite | null {
  let best: RootLite | null = null
  for (const r of roots) {
    if (!best) { best = r; continue }
    if (
      r.updated > best.updated ||
      (r.updated === best.updated && r.created > best.created) ||
      (r.updated === best.updated && r.created === best.created && r.id < best.id)
    ) {
      best = r
    }
  }
  return best
}

interface RootInspection {
  hasMessages: boolean
  lastTurnIncomplete: boolean
  /** `info.error` is present on the last message. A prior `/abort` (or opencode
   *  itself) already stamped this turn with an AbortError/MessageAbortedError
   *  without ever stamping `time.completed` — so it is already finalized, not
   *  orphaned. Re-aborting it would only re-emit the same `message.updated`/
   *  `session.error` to every client watching, re-rendering "Interrupted" for a
   *  turn that already ended. See `isTurnStillOrphaned`. */
  lastTurnHasError: boolean
  /** Identity of the last message, so a re-check can tell "same turn, still
   *  unfinished" from "a different turn has since started". */
  lastMessageId: string | null
  /**
   * False when the read failed — opencode unreachable, non-2xx, the 5s
   * timeout a cold post-resume opencode routinely hits, or an unparseable
   * response. Mirrors `RootInspection.known` in opencode-turn-state.ts (same
   * shape, same reason): without it, "genuinely no messages" and "could not
   * tell" are indistinguishable. Collapsing the second into the first either
   * re-delivers the initial prompt into a live conversation (boot's
   * reused-root path) or re-aborts a turn nobody actually confirmed was dead
   * (`finalizeOrphanedTurn`). Every other field on this shape is meaningless
   * when `known` is false — callers must check `known` first. See T12.
   */
  known: boolean
}

/**
 * Single source of truth for "is this turn still eligible to be aborted as
 * orphaned?" — incomplete AND not already carrying an error. Every finalize
 * path (boot's reused-root check, `finalizeOrphanedTurn`'s unplanned-respawn
 * check, and the settle re-check inside `confirmTurnOrphaned`) must route
 * through this instead of reading `lastTurnIncomplete` directly, so the error
 * guard cannot drift out of sync between them.
 *
 * `known: false` (the read failed) is never orphaned. We could not confirm
 * anything, so we must not abort a turn that might still be running — the
 * gate every caller here relies on. See `RootInspection.known`.
 */
function isTurnStillOrphaned(inspection: {
  lastTurnIncomplete: boolean
  lastTurnHasError: boolean
  known: boolean
}): boolean {
  if (!inspection.known) return false
  return inspection.lastTurnIncomplete && !inspection.lastTurnHasError
}

/**
 * Has the initial prompt already reached this root — or must we assume so?
 *
 * `known: false` means the read that would answer this failed (see
 * `RootInspection.known`). Treating that as "no messages" — the bug this
 * closes — reads as "never delivered" and re-delivers `prompt` into a
 * conversation that may already have it. Assuming delivered instead costs at
 * most one skipped bootstrap prompt on a root that turns out to be genuinely
 * empty, which is always safe to retry from outside: nothing observable ran
 * yet to redo. See T12.
 */
export function initialPromptAlreadyDelivered(existing: { known: boolean; hasMessages: boolean }): boolean {
  if (!existing.known) return true
  return existing.hasMessages
}

/**
 * T22/F1 — the initial-prompt gate for a REUSED root, one layer above
 * `initialPromptAlreadyDelivered`. OpenCode's `session.revert` is a STAGED
 * pointer; nothing is deleted until the next prompt — from ANY producer —
 * commits the truncation. A commit can truncate the reused root all the way
 * back to zero messages, and `initialPromptAlreadyDelivered` reads that
 * exactly like "never delivered" — re-running `prompt` (the original task
 * kickoff) into a session the user was mid-rewind on.
 *
 * F1: a bare prior pin is NOT proof of delivery — the pin is written BEFORE
 * `deliverInitialOpenCodePrompt` runs (see the call site), so a crash in that
 * window leaves a pin behind with nothing ever delivered. Treating any prior
 * pin as proof (the old T22 rule) then silences the session forever: every
 * later boot sees the pin and skips delivery. The durable delivery marker
 * (`readInitialPromptDeliveredMarker`, written only AFTER a successful
 * delivery) is the only unconditional proof. Short of that, a prior pin is
 * trusted ONLY when it also matches the root we actually reused AND that
 * root's transcript is confirmed non-empty — i.e. genuine reuse of a root
 * that plainly already has the conversation, not merely "some pin exists".
 *
 * `priorPin` must be read BEFORE this boot writes its own pin (see the call
 * site) so it reflects only what a PRIOR boot left behind — never this one's
 * own pending write. `deliveredMarkerExists` must likewise be read before
 * this boot's own (possible) marker write.
 *
 * Falls through to `initialPromptAlreadyDelivered`'s message-count read
 * (unchanged from T12) whenever neither the marker nor the matching-pin case
 * applies — covering both the pinless cold-reuse case and the crash-window
 * case (pin present, no marker, transcript confirmed empty: deliver).
 */
export function reusedRootAlreadyDelivered(
  existing: { id: string; known: boolean; hasMessages: boolean },
  priorPin: string | null,
  deliveredMarkerExists: boolean,
): boolean {
  if (deliveredMarkerExists) return true
  if (priorPin !== null && existing.id === priorPin && existing.known && existing.hasMessages) return true
  return initialPromptAlreadyDelivered(existing)
}

/**
 * How long to let an "incomplete" turn prove itself alive before aborting it.
 *
 * `lastTurnIncomplete` is `role === 'assistant' && !time.completed`, which is
 * equally true of a turn nobody is writing (orphaned by a dead opencode) and
 * one that is streaming right now. Aborting the second kind ends a healthy turn
 * and stamps it with an AbortError, which the UI renders as "Interrupted" under
 * an answer that finished perfectly well.
 *
 * The two are separable by waiting: nothing is writing an orphaned turn, so it
 * stays incomplete forever, while a live one completes in moments. Two seconds
 * is far longer than the gap between opencode finishing a turn and stamping
 * `time.completed`, and it costs nothing on the path that matters — a genuinely
 * orphaned turn is already broken and two seconds later still is.
 */
const ORPHAN_SETTLE_MS = 2_000

/** Does the root already have messages (prompt delivered), and is its last turn
 *  an assistant message left incomplete by a crash (no completion time)? */
async function inspectRoot(baseUrl: string, workspace: string, sessionId: string): Promise<RootInspection> {
  try {
    const res = await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    // Non-2xx (opencode answering but unhappy — e.g. mid-restart) is a read
    // failure, not "no messages": `known: false`.
    if (!res.ok) {
      return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, known: false }
    }
    const msgs = (await res.json()) as Array<{
      info?: { id?: string; role?: string; error?: unknown; time?: { completed?: number } }
    }>
    // An unparseable shape is also a read failure, not a genuinely empty root
    // — only an actual `[]` counts as a confirmed-empty root.
    if (!Array.isArray(msgs)) {
      return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, known: false }
    }
    if (msgs.length === 0) {
      return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, known: true }
    }
    const last = msgs[msgs.length - 1]
    const incomplete = last?.info?.role === 'assistant' && !last?.info?.time?.completed
    return {
      hasMessages: true,
      lastTurnIncomplete: Boolean(incomplete),
      lastTurnHasError: Boolean(last?.info?.error),
      lastMessageId: last?.info?.id ?? null,
      known: true,
    }
  } catch {
    // Unreachable, or the 5s AbortSignal.timeout above fired — the exact "cold
    // post-resume opencode" hazard this whole tri-state exists for.
    return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, known: false }
  }
}

/**
 * Is the turn actually ORPHANED, or just still being written?
 *
 * Look again after a settle window. Nothing is writing an orphaned turn, so it
 * is still incomplete; a live one has finished, and aborting it would have
 * ended a healthy answer and labelled it "Interrupted".
 *
 * Also refuses when the last message CHANGED — a different turn started in the
 * meantime, and that one is certainly alive.
 */
async function confirmTurnOrphaned(
  baseUrl: string,
  workspace: string,
  sessionId: string,
  first: RootInspection,
): Promise<boolean> {
  await new Promise((r) => setTimeout(r, ORPHAN_SETTLE_MS))
  const second = await inspectRoot(baseUrl, workspace, sessionId)
  if (!second.known) {
    // The settle re-check itself could not read the root. Do NOT abort on the
    // strength of the FIRST read alone — that would abort turns we can no
    // longer confirm are still incomplete now.
    logger.warn('[boot] could not confirm turn state during settle re-check; not aborting', { sessionId })
    return false
  }
  if (!second.lastTurnIncomplete) {
    logger.info('[boot] turn completed on its own; not aborting', { sessionId })
    return false
  }
  if (second.lastTurnHasError) {
    // A prior abort (or opencode itself) already stamped this turn with an
    // error without ever stamping `time.completed`. It is already finalized —
    // re-aborting it would only re-emit the same message.updated/session.error
    // to every client watching, re-rendering "Interrupted" on every boot.
    logger.info('[boot] turn already carries an error; already finalized, not aborting', { sessionId })
    return false
  }
  if (first.lastMessageId && second.lastMessageId !== first.lastMessageId) {
    logger.info('[boot] a newer turn started; not aborting', { sessionId })
    return false
  }
  return true
}

/** Finalize an interrupted turn so a streaming client stops spinning. */
async function abortOpencodeTurn(baseUrl: string, workspace: string, sessionId: string): Promise<void> {
  try {
    await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(workspace)}`,
      { method: 'POST', signal: AbortSignal.timeout(10_000) },
    )
    logger.info('[boot] aborted interrupted turn on reused root', { sessionId })
  } catch (err) {
    logger.warn('[boot] failed to abort interrupted turn', { sessionId, err: (err as Error).message })
  }
}

/**
 * Report the canonical opencode root to apps/api so it writes the durable DB
 * pin (project_sessions.opencode_session_id) at bootstrap — no browser needed.
 * Best-effort and fire-once: even if it never lands (transient blip), the API
 * still heals the pin on the first /ensure-opencode. Never blocks boot.
 */
async function relayBootstrapPinToApi(opencodeSessionId: string): Promise<void> {
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  // /turn-stream accepts EITHER the session token or the sandbox credential
  // (it's a sandbox-identity route). Prefer the session token; fall back to the
  // sandbox credential — canonical name first, legacy KORTIX_TOKEN alias last.
  const token = (process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        kind: 'opencode_session',
        opencode_session_id: opencodeSessionId,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      logger.warn('[boot] bootstrap pin relay non-ok', { status: res.status })
      return
    }
    logger.info('[boot] bootstrap opencode session pinned via api', { opencodeSessionId })
  } catch (err) {
    logger.warn('[boot] bootstrap pin relay failed', { err: (err as Error).message })
  }
}

export async function createInitialOpenCodeSession(
  opencode: Opencode,
  workspace: string,
): Promise<{ id: string }> {
  const response = await waitForInitialSessionCreate(opencode.getInternalUrl(), workspace)
  const session = (await response.json()) as { id?: string }
  if (!session.id) throw new Error('opencode session create returned no id')
  return { id: session.id }
}

export async function deliverInitialOpenCodePrompt(
  opencode: Opencode,
  sessionId: string,
  workspace: string,
  prompt: ReturnType<typeof buildInitialPromptBody>,
): Promise<void> {
  const response = await fetch(
    `${opencode.getInternalUrl()}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(workspace)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) {
    throw new Error(`opencode prompt failed: ${response.status} ${await response.text()}`)
  }
}

/**
 * Promote only the initial-turn authority that apps/api created before the
 * sandbox existed. The daemon cannot mint a token, create a lifecycle record,
 * or revive a record removed by terminal evidence.
 */
export async function relayInitialTurnAcceptedToApi(
  opencodeSessionId: string,
  messageId: string,
  turnToken: string,
): Promise<boolean> {
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  const sandboxToken = (process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !sandboxToken || !apiUrl) {
    throw new Error('initial turn acceptance relay context is unavailable')
  }
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  const response = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sandboxToken}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      kind: 'turn_accepted',
      opencode_session_id: opencodeSessionId,
      turn_message_id: messageId,
      turn_token: turnToken,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`initial turn acceptance rejected: ${response.status} ${body.slice(0, 200)}`)
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
  return body.ok === true
}

/** Claim the pending first turn through the session-bound Kortix credential. */
export async function claimInitialTurnFromApi(): Promise<InitialTurnClaim | null> {
  if (claimedInitialTurn) return claimedInitialTurn
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  const token = process.env.KORTIX_TOKEN?.trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return null
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  let response: Response | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: sessionId, kind: 'initial_turn_claim' }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok || response.status < 500) break
      lastError = new Error(`initial turn claim returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < 2) await Bun.sleep(250 * 2 ** attempt)
  }
  if (!response) {
    throw new Error(`initial turn claim failed after 3 attempts: ${String(lastError)}`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`initial turn claim rejected: ${response.status} ${body.slice(0, 200)}`)
  }
  const body = (await response.json()) as {
    initial_turn?: { prompt?: unknown; turn_token?: unknown; message_id?: unknown } | null
  }
  const turn = body.initial_turn
  if (
    !turn ||
    typeof turn.prompt !== 'string' ||
    typeof turn.turn_token !== 'string' ||
    typeof turn.message_id !== 'string'
  ) return null
  claimedInitialTurn = {
    prompt: turn.prompt,
    turnToken: turn.turn_token,
    messageId: turn.message_id,
  }
  return claimedInitialTurn
}

/** Remove only a pre-created initial-turn record that OpenCode never accepted. */
export async function relayInitialTurnAbandonedToApi(turnToken: string): Promise<boolean> {
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  const sandboxToken = (process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !sandboxToken || !apiUrl) {
    throw new Error('initial turn abandonment relay context is unavailable')
  }
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  const response = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sandboxToken}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      kind: 'turn_abandoned',
      turn_token: turnToken,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`initial turn abandonment rejected: ${response.status} ${body.slice(0, 200)}`)
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
  return body.ok === true
}

export type InitialTurnAcceptanceReconciliation = 'accepted' | 'inactive' | 'unknown'

/**
 * Promote daemon-delivered authority only after OpenCode exposes the exact
 * client-minted user message as queued or running.
 *
 * A restart can reuse a root that already contains an older prompt. Root-level
 * `hasMessages` evidence is therefore insufficient: it would promote a new
 * token for work that the daemon deliberately did not rerun.
 */
export async function reconcileInitialTurnAcceptanceToApi(
  opencodeBaseUrl: string,
  workspace: string,
  opencodeSessionId: string,
  messageId: string,
  turnToken: string,
): Promise<InitialTurnAcceptanceReconciliation> {
  const inFlight = await opencodeDeliveryInFlight(
    opencodeBaseUrl,
    workspace,
    opencodeSessionId,
    messageId,
  )
  if (inFlight === null) return 'unknown'
  if (!inFlight) {
    await relayInitialTurnAbandonedToApi(turnToken)
    return 'inactive'
  }
  await relayInitialTurnAcceptedToApi(opencodeSessionId, messageId, turnToken)
  return 'accepted'
}

/**
 * Create the session's root opencode conversation, retrying while opencode is
 * still coming up.
 *
 * The per-attempt budget is deliberately MUCH larger than the call's normal cost.
 * Measured 2026-07-25 against the real binary, `POST /session` is ~370ms once
 * opencode is warm — but Platinum guests run ~3x slower than Daytona on
 * CPU-bound work (`static-web` 5→19ms, `git-identity` 13→44ms at an identical
 * 2-vCPU spec), which puts a genuine Platinum session-create right at ~1.1s: over
 * the 1s budget this used to impose. Aborting there was actively harmful in two
 * ways:
 *
 *  1. It threw away a call that was about to succeed and paid the whole cost
 *     again (~1.05s per wasted round), on the critical path that
 *     `opencode-session-created` measures.
 *  2. A client-side abort does NOT cancel opencode's server-side work. The
 *     resend could therefore run session-create CONCURRENTLY with the one still
 *     in flight, and only whichever returned first got pinned — leaving an
 *     orphaned duplicate root nobody cleans up, in a codebase that goes to
 *     lengths elsewhere (resolveExistingRoot, the seed-root rotation) precisely
 *     to guarantee one root per session.
 *
 * So: give each attempt room to actually finish, and only retry when the request
 * failed at the connection level (opencode not listening yet) rather than on our
 * own impatience. The 20s outer deadline is unchanged and still bounds the whole
 * loop.
 */
const SESSION_CREATE_ATTEMPT_TIMEOUT_MS = 10_000

export async function waitForInitialSessionCreate(baseUrl: string, workspace: string): Promise<Response> {
  const url = `${baseUrl}/session?directory=${encodeURIComponent(workspace)}`
  const deadline = Date.now() + 20_000
  let lastError = 'opencode session create timed out'
  while (Date.now() < deadline) {
    // Never let one attempt outlive the outer deadline.
    const attemptMs = Math.max(500, Math.min(SESSION_CREATE_ATTEMPT_TIMEOUT_MS, deadline - Date.now()))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(attemptMs),
      })
      if (res.ok) return res
      const body = await res.text().catch(() => '')
      lastError = `opencode session create failed: ${res.status} ${body}`
      if (res.status >= 400 && res.status < 500 && res.status !== 404) break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      // A timeout means opencode ACCEPTED the request and is still working on it.
      // Resending would duplicate the root (see the doc comment), so stop and let
      // the caller surface it rather than racing ourselves.
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      if (timedOut) break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(lastError)
}

type SandboxRelayContext = {
  projectId: string
  sessionId: string
  token: string
  apiRoot: string
}

// The control-plane callback context for every project session. The sandbox
// credential can call the sandbox-identity turn-stream route. This callback is
// safe for web, CLI, Slack, Teams, and email sessions.
function sandboxRelayContext(tokenOverride?: string | null): SandboxRelayContext | null {
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  // /turn-stream accepts EITHER the session token or the sandbox credential
  // (it's a sandbox-identity route). Prefer the session token; fall back to the
  // sandbox credential — canonical name first, legacy KORTIX_TOKEN alias last.
  const token =
    tokenOverride !== undefined
      ? (tokenOverride ?? '')
      : (process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) {
    logger.warn('[opencode-events] missing env to relay to apps/api', {
      hasProject: !!projectId, hasSession: !!sessionId, hasToken: !!token, hasApi: !!apiUrl,
    })
    return null
  }
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  return { projectId, sessionId, token, apiRoot }
}

// Question relays remain Slack-only. A web session answers the question tool
// through OpenCode SSE and must not receive the Slack sentinel response.
function slackRelayContext(): SandboxRelayContext | null {
  if (!(process.env.SLACK_THREAD_TS || process.env.SLACK_CHANNEL_ID)) return null
  return sandboxRelayContext()
}

// Relay an opencode `question.asked` event for a SLACK session: post the
// question(s) into the thread and resume the agent's (blocking) `question` tool
// with a sentinel so the turn ends — the user's in-thread reply / button click
// arrives as a new turn.
//
// "Is this a Slack session?" is read straight from the sandbox env, which IS the
// session metadata: a Slack session is tagged `metadata.slack` at creation, and
// the API projects that into SLACK_THREAD_TS / SLACK_CHANNEL_ID on EVERY
// (re)provision (buildSessionChannelEnv). A web/dashboard session has no such
// metadata, so it has no such env and `slackRelayContext()` returns null.
//
// That distinction now gates RESOLVING the question, not reporting it. Every
// session reports it, so the control plane can persist it and the ask survives
// the box being parked. Only a channel session auto-answers opencode's blocking
// call, because only there does the reply arrive out of band. The dashboard
// answers `question.asked` interactively over opencode's own SSE, and
// auto-answering it here is the "every question is auto-answered even outside
// Slack" bug. No round-trip, no status codes — the env is the source of truth.
async function relayQuestionToApi(
  req: QuestionRequest,
  cfg: Config,
  opencode: ReturnType<typeof createOpencodeSupervisor>,
): Promise<void> {
  // EVERY session, not just Slack ones.
  //
  // This used to take `slackRelayContext()`, which returns null without
  // SLACK_THREAD_TS / SLACK_CHANNEL_ID — so for a web session apps/api never
  // learned a question was pending. The box was then parked on schedule (a
  // waiting turn makes no LLM calls, so it earns no extension — that part is
  // correct), and the question died with it, because opencode restarts cold.
  // The user came back to a session that had silently forgotten what it asked.
  //
  // The control plane now PERSISTS the question regardless of channel, so
  // reporting it is useful for every session. Posting it into a thread is still
  // channel-specific and stays server-side.
  const ctx = sandboxRelayContext()
  if (!ctx) return
  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-question`
  logger.info('[opencode-events] relaying question.asked', {
    requestId: req.id, questions: req.questions.length,
  })

  // Best-effort: render the question(s) into the thread. Independent of the
  // resume below — a Slack turn must never hang waiting on this.
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        request_id: req.id,
        opencode_session_id: req.sessionID,
        questions: req.questions,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    logger.warn('[opencode-events] turn-question post failed (non-fatal)', { err: (err as Error).message })
  }

  // PERSISTING the question is for every session. RESOLVING it here is not.
  //
  // In a channel session the reply genuinely arrives out of band — the user
  // types in the Slack thread and it reaches the agent as a new turn — so the
  // blocking call must be released or the turn hangs ("stuck until I kill it
  // manually").
  //
  // A dashboard session is the opposite: the UI answers `question.asked`
  // interactively over opencode's own SSE, so the call SHOULD keep blocking
  // while the box is alive. Auto-answering it here is the "every question is
  // auto-answered even outside Slack" bug described above — which the relay
  // ungate silently brought back, because the sentinel then fired for every
  // session. Seen live on dev 2026-08-05: a web session's agent was told
  // "Posted to the Slack thread" (it was not) and replied "I'll use `slack
  // send` for questions in this environment going forward instead of the
  // `question` tool" — the tool park-and-restore exists to make reliable.
  //
  // If the box is parked while the question is still open, the control plane
  // has it (persisted above) and POST /sessions/:id/question delivers the answer
  // as a follow-up turn. Nothing is lost by leaving this one blocked.
  if (!slackRelayContext()) {
    logger.info('[opencode-events] question persisted; left open for the UI', {
      requestId: req.id,
    })
    return
  }

  const sentinel =
    '(Posted to the Slack thread. In Slack, questions are async — the user replies ' +
    'as a normal message, which reaches you as a NEW turn with full context. Do NOT ' +
    'wait for an answer here; finish this turn now. Next time, just ask with ' +
    '`slack send` rather than the question tool.)'
  const answers: string[][] = req.questions.map(() => [sentinel])
  const replyUrl = `${opencode.getInternalUrl()}/question/${encodeURIComponent(req.id)}/reply?directory=${encodeURIComponent(cfg.workspace)}`
  try {
    const r = await fetch(replyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      logger.warn('[opencode-events] opencode question.reply non-ok', {
        status: r.status, body: (await r.text()).slice(0, 300),
      })
      return
    }
    logger.info('[opencode-events] question resolved async (sentinel)', { requestId: req.id })
  } catch (err) {
    logger.warn('[opencode-events] opencode question.reply failed', { err: (err as Error).message })
  }
}

// Relay a turn ending (opencode `session.idle` / `session.error`) for the ROOT
// turn to apps/api. The API finalizes channel output and shortens the sandbox
// deadline to the configured idle grace. OpenCode emits these events for every
// session, including Task-tool children, so only root events can relay.
// Turn-end dedup: the last (opencodeSessionId, turnSignature) we already relayed.
// The signature is the completed turn's identity (last assistant message's
// completed timestamp), so a turn is finalized EXACTLY ONCE no matter which path
// observes it — the natural session.idle, the reconcile-on-subscribe backstop, or
// a duplicate idle from opencode. A genuinely NEW turn has a new completed
// timestamp → a fresh signature → it relays normally. session.error is never
// deduped here (it carries no completed signature and the API's claimFinalize is
// the single-winner backstop). Cleared implicitly by moving to a new signature.
const relayedTurnSignatures = new Set<string>()

/** Test-only: clear the per-turn dedup set between cases. */
export function __resetRelayedTurnSignatures(): void {
  relayedTurnSignatures.clear()
}

// Turn-begin relay dedup: root id -> the newest user message id already
// relayed (or refused as already-known by apps/api). A turn's identity is its
// user message, so one turn relays once no matter how many `busy`/`retry`
// status frames it emits. Per-process, like `relayedTurnSignatures`.
const relayedTurnBegins = new Map<string, string>()
const turnBeginRelaysInFlight = new Set<string>()

/** Test-only: clear the per-turn begin dedup between cases. */
export function __resetRelayedTurnBegins(): void {
  relayedTurnBegins.clear()
  turnBeginRelaysInFlight.clear()
}

/**
 * Announce a BOX-INITIATED turn to apps/api (`turn-stream` kind `turn_begin`).
 *
 * Every control-plane prompt gets its `session_turns` row BEFORE delivery, but
 * OpenCode also starts turns nobody delivered — the synthetic `<pty_exited>`
 * user message it injects when a background pty finishes. Those turns had no
 * authority at all: `GET .../turn` read idle over minutes of live streaming
 * and the box ran on its 15-minute idle tail (live incident 2026-08-20,
 * Essentia session d1b74954). This relay fires on the root's `busy`/`retry`
 * status frames and names the newest user message; apps/api adopts it only
 * when no open turn exists and the message was never seen — so relaying for
 * an ordinary delivered prompt is a cheap no-op.
 */
export async function relayTurnBeginToApi(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<void> {
  // The session credential is bound to this sandbox's session_id. The API
  // treats that claim as the daemon identity for lifecycle-only callbacks.
  const sandboxToken = (process.env.KORTIX_TOKEN || '').trim()
  if (!sandboxToken) return
  const ctx = sandboxRelayContext(sandboxToken)
  if (!ctx) return
  if (turnBeginRelaysInFlight.has(opencodeSessionId)) return
  turnBeginRelaysInFlight.add(opencodeSessionId)
  try {
    if (!(await isRootOpencodeSession(opencodeSessionId, opencode, cfg))) return
    // The newest USER message names the turn that is running.
    let newestUserId: string | null = null
    try {
      const res = await fetch(
        `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/message?directory=${encodeURIComponent(cfg.workspace)}`,
        { signal: AbortSignal.timeout(5_000) },
      )
      if (!res.ok) return
      const rows = (await res.json()) as Array<{ info?: { id?: string; role?: string } }>
      if (!Array.isArray(rows)) return
      for (let i = rows.length - 1; i >= 0; i--) {
        const info = rows[i]?.info
        if (info?.role === 'user' && typeof info.id === 'string') {
          newestUserId = info.id
          break
        }
      }
    } catch {
      return
    }
    if (!newestUserId) return
    if (relayedTurnBegins.get(opencodeSessionId) === newestUserId) return

    const { projectId, sessionId, token, apiRoot } = ctx
    const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
    const payload = JSON.stringify({
      session_id: sessionId,
      kind: 'turn_begin',
      opencode_session_id: opencodeSessionId,
      turn_message_id: newestUserId,
    })
    // Two attempts only: `busy`/`retry` frames recur for a live turn, so a
    // transient failure retries itself on the next frame.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: payload,
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          // ANY definitive answer dedups: adopted, already-open, or
          // already-known all mean this exact message needs no further relay.
          relayedTurnBegins.set(opencodeSessionId, newestUserId)
          const data = (await res.json().catch(() => null)) as { outcome?: string } | null
          if (data?.outcome === 'adopted') {
            logger.info('[opencode-events] box-initiated turn adopted', {
              opencodeSessionId,
              messageId: newestUserId,
            })
          }
          return
        }
        logger.warn('[opencode-events] turn-begin relay non-ok', { status: res.status, attempt })
      } catch (err) {
        logger.warn('[opencode-events] turn-begin relay fetch failed', {
          err: (err as Error).message,
          attempt,
        })
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1_000))
    }
  } finally {
    turnBeginRelaysInFlight.delete(opencodeSessionId)
  }
}

export async function relayTurnEndToApi(
  opencodeSessionId: string,
  status: 'idle' | 'error',
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
  eventError?: OpencodeTurnError,
): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return

  // Resolve the turn's error + completed signature in one read. session.error
  // already hands us the error; an idle end (e.g. retries exhausted, then idle)
  // carries none, so read the session's last assistant message — exactly what
  // the web UI shows — and upgrade idle→error when it failed. This is what turns
  // a blank "ended without a reply" in Slack into "out of credits" / rate-limit /
  // the real error. The completed timestamp doubles as the per-turn dedup key.
  //
  // Read BEFORE the root filter, because the runaway guard below must see EVERY
  // session's completions: the 2026-08-18 Essentia incident was a CHILD session
  // re-answering the same standing prompt indefinitely, and with the guard
  // placed after the root filter it never saw a single one of those repeats.
  const turn = await readRootTurnState(opencodeSessionId, opencode, cfg)
  const error = eventError ?? turn.error
  const effectiveStatus = error ? 'error' : status
  const isRoot = await isRootOpencodeSession(opencodeSessionId, opencode, cfg)

  // A genuinely new, non-duplicate `idle` completion — check it isn't the SAME
  // standing prompt answering itself again with no new user message in between
  // (see `runaway-turn-guard.ts`). Per opencode session id, ROOT AND CHILDREN:
  // the abort targets the session that is looping. Scoped to `idle` only: an
  // `error` completion repeating is `turn-auto-resume.ts`'s concern.
  const runawayCheck = (): void => {
    if (effectiveStatus !== 'idle') return
    void observeIdleForRunaway(opencodeSessionId, turn.parentMessageId, async () => {
      try {
        await fetch(
          `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/abort?directory=${encodeURIComponent(cfg.workspace)}`,
          { method: 'POST', signal: AbortSignal.timeout(10_000) },
        )
      } catch (err) {
        logger.warn('[runaway-turn-guard] abort call failed', { opencodeSessionId, err: (err as Error).message })
      }
    })
  }

  // Only the root turn closes channel output and shortens the idle deadline. A
  // subagent can become idle while the root turn still runs. Detect the root by
  // parentID, not by a session pin that can change after an OpenCode restart.
  // A child's completion is still guarded above — but a child has no per-turn
  // relay dedup signature of its own, so it steps the guard on every idle it
  // reports. Under a real loop those are distinct completions; a duplicate
  // observation of one child completion costs at most one extra tolerated
  // repeat (MAX_CONSECUTIVE_REPEATS absorbs it), never a false abort of a
  // healthy child.
  if (!isRoot) {
    runawayCheck()
    return
  }

  // Exactly-once per completed turn: an idle turn (natural OR reconciled on
  // subscribe) relays a single time. The signature is only RECORDED after a
  // confirmed relay (below), so a transient API outage that fails all retries
  // never permanently suppresses the reconcile backstop — a later observation of
  // the same turn can still relay it. Errors have no completed signature, so they
  // always pass through and rely on the API's single-winner claimFinalize.
  const dedupSig =
    effectiveStatus === 'idle' && turn.completedAt != null
      ? `${opencodeSessionId}:${turn.completedAt}`
      : null
  if (dedupSig && relayedTurnSignatures.has(dedupSig)) {
    logger.info('[opencode-events] turn-end already relayed for this turn; skipping', { opencodeSessionId })
    return
  }

  // Root: past the turn-end dedup, so a duplicate observation of one real
  // reply never reads as a repeat.
  runawayCheck()

  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
  const payload = JSON.stringify({
    session_id: sessionId,
    kind: 'end',
    status: effectiveStatus,
    opencode_session_id: opencodeSessionId,
    turn_message_id: turn.parentMessageId ?? undefined,
    ...(error
      ? {
          error_name: error.name,
          error_message: error.message,
          error_status: error.statusCode,
          error_retryable: error.isRetryable,
          error_provider: error.providerID,
        }
      : {}),
  })
  // This is the ONLY signal that finalizes a turn the agent ended without
  // `slack send` (otherwise the ⏳ lingers until the 30-min GC). It must not be
  // best-effort: retry with backoff before giving up. A non-ok HTTP response is
  // a definitive answer from apps/api (e.g. already finalized), so we stop on any
  // `res.ok`; only network/5xx failures are retried.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        // Record the dedup signature ONLY on a confirmed relay — a res.ok is a
        // definitive answer from apps/api (relayed, or already-finalized), so a
        // later observation of the same completed turn is a safe no-op to skip.
        if (dedupSig) relayedTurnSignatures.add(dedupSig)
        const data = (await res.json().catch(() => null)) as { ok?: boolean } | null
        if (data?.ok) logger.info('[opencode-events] turn end relayed', { status: effectiveStatus, errorName: error?.name, opencodeSessionId, attempt })
        return
      }
      logger.warn('[opencode-events] turn-end relay non-ok', { status: res.status, attempt })
    } catch (err) {
      logger.warn('[opencode-events] turn-end relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, 1_000 * attempt))
  }
  logger.error('[opencode-events] turn-end relay gave up after retries', { sessionId, status: effectiveStatus })
}

interface RootTurnState {
  /** The turn's failure (from the last assistant message), if any. */
  error?: OpencodeTurnError
  /** The last assistant message's completion time — the turn's completed
   *  identity, used as the exactly-once dedup key. null while the turn is still
   *  running (assistant message present but not completed) or before any reply. */
  completedAt: number | null
  /** The user message this assistant turn answers. This is the stable identity
   *  minted by the client and recorded by apps/api before prompt delivery. */
  parentMessageId: string | null
}

// Read the ROOT turn's outcome from its last assistant message — the same
// `AssistantMessage.error` the web UI renders — plus its completion timestamp.
// opencode's session.error event already carries the error for a hard failure,
// but a run that exhausts retries (e.g. out of credits / rate-limited) can end on
// `session.idle` with the error only on the message; this is what lets Slack still
// say *why* instead of going silent. The `completedAt` is the per-turn dedup key
// so a turn finalizes exactly once regardless of which path observes its end.
// Best-effort: any miss/parse failure returns a clean, un-completed state, so this
// never turns a healthy turn into a phantom failure.
async function readRootTurnState(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<RootTurnState> {
  try {
    const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/message?directory=${encodeURIComponent(cfg.workspace)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return { completedAt: null, parentMessageId: null }
    const rows = (await res.json()) as Array<{
      info?: {
        role?: string
        parentID?: string
        time?: { completed?: number }
        error?: {
          name?: string
          data?: {
            message?: string
            statusCode?: number
            isRetryable?: boolean
            providerID?: string
          }
        }
      }
    }>
    if (!Array.isArray(rows)) return { completedAt: null, parentMessageId: null }
    // The most recent assistant message decides the turn's outcome. Trailing
    // USER rows are SKIPPED, not a boundary: a prompt forwarded into a live
    // turn — and OpenCode's own synthetic `<pty_exited>` wake-ups — leave a
    // user message as the newest row at almost every turn end, and bailing
    // there unnamed EVERY relay for such sessions (live 2026-08-20, Essentia
    // session d1b74954: `relay_named:false` on each end, double finalizes
    // because the unnamed relay has no dedup signature, and the forwarded-turn
    // reconciler lost its primary key). Attribution is message-scoped — the
    // assistant's own `parentID` names the turn it answered — so a pending
    // follow-up prompt can never be blamed for a prior turn's error.
    //
    // A newest assistant that is still OPEN (no completion, no terminal error)
    // is not automatically a dead end either. WHICH TURN it belongs to decides,
    // and `parentID` says so — the same linkage the API-side husk finalizer
    // matches on. Two different shapes hide behind one open row:
    //
    //   `[uA, aA1(done), aA2(open)]`   one turn, mid-step  → STAY UNNAMED.
    //       Naming aA1 would let completeSandboxTurn close a row whose turn is
    //       still streaming.
    //   `[uA, aA(done), uB, aB(open)]` turn A ended, B races → NAME A.
    //       The idle being handled cannot be B's (B is open), so A is the turn
    //       that ended. The old code stopped at the open row and relayed A with
    //       no `turn_message_id` and no dedup signature — the ledger row then
    //       never closed by message and waited for a reaper sweep, which is a
    //       direct "stuck working forever" contributor.
    //
    // An open row whose `parentID` is missing proves nothing about which turn
    // is running, so it keeps the old conservative unnamed answer.
    let openTurnParentId: string | null | undefined
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info
      if (info?.role !== 'assistant') continue
      const open =
        info.time?.completed == null && (!info.error || info.error.data?.isRetryable === true)
      if (open) {
        if (openTurnParentId === undefined) openTurnParentId = info.parentID ?? null
        continue
      }
      const sameTurnAsTheOpenOne =
        openTurnParentId !== undefined &&
        (openTurnParentId === null || info.parentID == null || info.parentID === openTurnParentId)
      if (sameTurnAsTheOpenOne) return { completedAt: null, parentMessageId: null }
      return {
        error: info.error ? flattenOpencodeError(info.error) : undefined,
        completedAt: info.time?.completed ?? null,
        parentMessageId: info.parentID ?? null,
      }
    }
    return { completedAt: null, parentMessageId: null }
  } catch {
    return { completedAt: null, parentMessageId: null }
  }
}

// Reconcile-on-subscribe backstop for the fast-boot event-loss race. When the
// /event SSE connects, the FIRST turn may have already reached session.idle in
// the prompt→subscribe gap (a fast boot + a trivial prompt), so the idle event
// was fired before anyone was listening and is gone. Read the pinned root's
// last-turn state directly: if it has already COMPLETED (an assistant message
// with a completion time), relay a synthetic turn-end so the turn finalizes even
// though its live event was missed. relayTurnEndToApi dedups by the completed
// signature, so if the natural idle WASN'T dropped this is a no-op. The callback
// works for all project sessions and remains a no-op without sandbox identity.
export async function reconcileFinishedFirstTurn(
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<void> {
  if (!sandboxRelayContext()) return
  const rootId = readPinnedOpencodeSessionId()
  if (!rootId) return
  const turn = await readRootTurnState(rootId, opencode, cfg)
  // Only reconcile a turn that has actually completed; a still-running turn will
  // finalize via its own (now-subscribed) session.idle.
  if (turn.completedAt == null) return
  logger.info('[opencode-events] reconciling turn that completed before subscribe', { rootId, completedAt: turn.completedAt })
  await relayTurnEndToApi(rootId, 'idle', opencode, cfg)
}

// Is this opencode session the ROOT turn session (not a subagent child)? A root
// has no parentID; Task-tool children do. We ask opencode directly rather than
// comparing against the boot-pinned id: an opencode restart can mint a NEW root
// and orphan the old pin, and gating turn-end on pin-equality then filters out
// the REAL turn's `session.idle` — the Slack message then loads forever. parentID
// is the objective signal that survives a re-pin. On any uncertainty, return
// false so we never close the stream prematurely — the GC sweep is the backstop.
async function isRootOpencodeSession(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<boolean> {
  try {
    const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}?directory=${encodeURIComponent(cfg.workspace)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return false
    const session = (await res.json()) as { parentID?: string | null }
    return !session.parentID
  } catch {
    return false
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
export function resolveOpencodeModel(): { providerID: string; modelID: string } | undefined {
  const raw = (process.env.KORTIX_OPENCODE_MODEL ?? '').trim()
  if (!raw) return undefined
  if (hasKortixLlmGateway(process.env)) {
    const modelID = raw.startsWith('kortix/') ? raw.slice('kortix/'.length) : raw
    return modelID ? { providerID: 'kortix', modelID } : undefined
  }
  if (LEGACY_OPENCODE_ZEN_FREE_MODELS.has(raw)) return { providerID: 'opencode', modelID: raw }
  // A pin stored while the gateway was ON can survive a live toggle to native
  // mode. `kortix/<provider>/<model>` (a nested BYOK/codex wire ref) strips to
  // the native ref it wraps; a bare `kortix/<managed-id>` has no native
  // provider to map onto, so it is dropped and OpenCode's default applies —
  // never a prompt against the nonexistent `kortix` provider.
  const ref = raw.startsWith('kortix/') ? raw.slice('kortix/'.length) : raw
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return undefined
  const providerID = ref.slice(0, slash)
  const modelID = ref.slice(slash + 1)
  return { providerID, modelID }
}

/** Build the first-turn request from the session-bound runtime environment. */
export function buildInitialPromptBody(prompt: string, claimedMessageId?: string): {
  messageID?: string
  parts: Array<{ type: 'text'; text: string }>
  model?: { providerID: string; modelID: string }
  agent?: string
} {
  const model = resolveOpencodeModel()
  const agentName = (process.env.KORTIX_AGENT_NAME ?? '').trim()
  const agent = agentName && agentName !== 'default' ? agentName : undefined
  const messageID = claimedMessageId
  return {
    ...(messageID ? { messageID } : {}),
    parts: [{ type: 'text', text: prompt }],
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
  }
}

/** Read the pinned OpenCode session id. Returns null if no session was pinned — caller decides
 *  whether to fail or fall back to creating a fresh session. */
export function readPinnedOpencodeSessionId(): string | null {
  try {
    if (!existsSync(OPENCODE_SESSION_PIN_PATH)) return null
    const id = readFileSync(OPENCODE_SESSION_PIN_PATH, 'utf8').trim()
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

// Subcommand dispatch. The compiled binary is reused as a git credential
// helper (`kortix-agent git-credential get`) — git execs it when it needs a
// push/clone credential for the managed remote. Detect that mode before the
// daemon boot path so we don't spin up opencode/proxy just to print a token.
const subcommand = process.argv[2]
if (import.meta.main) {
  if (subcommand === 'git-credential') {
    runGitCredentialHelper(loadConfig(), process.argv[3])
      .then((code) => process.exit(code))
      .catch(() => process.exit(0))
  } else if (subcommand === 'install-compiled-runtime') {
    installCompiledRuntime(loadConfig())
      .then((result) => {
        process.stdout.write(`${result.path}\n`)
        process.exit(0)
      })
      .catch((error) => {
        process.stderr.write(
          `[compiled-runtime] install failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exit(1)
      })
  } else if (isManagementSubcommand(subcommand)) {
    // kortixd management CLI: version / install / update / rollback /
    // --health-check / --help. `serve` and any unrecognized verb fall through
    // to the daemon below. See src/cli.ts.
    dispatchCli(process.argv.slice(2))
      .then((outcome) => {
        if (outcome.action === 'exit') process.exit(outcome.code)
        // action === 'serve' cannot happen here (management verbs never serve),
        // but boot the daemon defensively rather than exit silently.
        main().catch((err) => {
          logger.error('[boot] fatal', err)
          process.exit(1)
        })
      })
      .catch((err) => {
        process.stderr.write(`[kortixd] ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      })
  } else {
    main().catch((err) => {
      logger.error('[boot] fatal', err)
      process.exit(1)
    })
  }
}
