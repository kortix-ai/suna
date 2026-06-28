import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { agentEnvDirIsTmpfs, writeAgentEnvFile } from './agent-env-file'
import { loadConfig, resolveOpencodeConfigDir, resolveSandboxOnBoot, type Config } from './config'
import {
  configureGitCredentialHelper,
  configureGlobalGitIdentity,
  configureRepoCredentialHelper,
  materializeRepo,
  materializeScaffoldSeed,
  materializeProjectSeed,
  runGitCredentialHelper,
} from './git'
import { logger } from './logger'
import { createOpencodeSupervisor, OPENCODE_HOME, waitForOpencodeReady, type Opencode } from './opencode'
import { ensureOpencodeConfigDeps } from './opencode-config-deps'
import { isSharedSeedBakedRoot, OPENCODE_SEED_BAKED_PIN_PATH } from './opencode-fork-root'
import { startOpencodeEventLoop, flattenOpencodeError, type QuestionRequest, type OpencodeTurnError } from './opencode-events'
import { createProjectEnvStore } from './project-env'
import { startProxy } from './proxy'
import {
  startLlmProxy,
  setLlmProxyToken,
  llmProxyReady,
  llmProxyBaseUrl,
  startExecutorProxy,
  setExecutorProxyToken,
  executorProxyReady,
  executorProxyBaseUrl,
} from './llm-proxy'
import type { SandboxBootState } from './routes/health'
import { installShutdownHandlers } from './shutdown'
import { startStaticWebServer } from './static-web'

// Pin file for the opencode session created from KORTIX_INITIAL_PROMPT.
// Webhook follow-ups (e.g. Slack thread replies) read this to deliver new
// prompts into the same opencode conversation instead of opening a fresh
// session with no context.
export const OPENCODE_SESSION_PIN_PATH = '/var/run/kortix/opencode-session-id'
const LEGACY_OPENCODE_ZEN_FREE_MODELS = new Set([
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
])

async function main() {
  const bootTime = Date.now()
  const cfg = loadConfig()
  const prompt = (process.env.KORTIX_INITIAL_PROMPT ?? '').trim()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  const bootState: SandboxBootState = {
    repoMaterializationError: null,
    timeline: [],
    initialOpenCodeSessionRequired: prompt.length > 0 || bootstrapSession,
    initialOpenCodeSessionId: null,
    initialOpenCodeSessionError: null,
  }
  // In-container boot timeline (ms since process start). Surfaced via
  // /kortix/health so the dashboard can attribute post-create boot latency.
  const bootMark = (label: string) => {
    bootState.timeline.push({ label, atMs: Date.now() - bootTime })
  }
  logger.info('[boot] kortix-sandbox-agent-server starting', {
    servicePort: cfg.servicePort,
    opencodeInternalPort: cfg.opencodeInternalPort,
    staticPort: cfg.staticPort,
    autoClone: cfg.autoClone,
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

  // The opencode config dir lives INSIDE the repo (`<workspace>/.kortix/
  // opencode`), so the repo MUST be materialized before we can resolve which
  // config dir opencode should launch with. Resolving before the clone always
  // missed the project's opencode.jsonc and silently fell back to the baked
  // default dir — so the session ran with NO custom agents/plugins/commands
  // and not even the project's `default_agent`. Clone first, then resolve.
  //
  // opencode is spawned AFTER the clone (not in parallel): OPENCODE_CONFIG_DIR
  // is fixed at spawn time, so the dir has to be known up front. The clone is
  // the boot long-pole; the opencode spawn (binary launch + port bind) is fast
  // and opencode doesn't touch the workspace until its first request anyway.
  const projectEnv = createProjectEnvStore()
  if (!agentEnvDirIsTmpfs()) {
    logger.error('[boot] /dev/shm is not tmpfs — agent secret file would persist to disk; check the sandbox runtime mount')
  }
  if (!writeAgentEnvFile(projectEnv)) {
    logger.error('[boot] failed to write agent secret env file; agent shells will lack project secrets')
  }
  const repoMaterializePromise: Promise<void> = cfg.autoClone
    ? materializeRepo(cfg).catch((err) => {
        bootState.repoMaterializationError = err instanceof Error ? err.message : String(err)
        logger.error('[boot] repo materialization failed', err)
      })
    : Promise.resolve()

  // Wait for the clone to finish before we let downstream code (config-dir
  // resolution, readiness probe, initial session creation) think the workspace
  // is ready.
  await repoMaterializePromise
  bootMark('repo-materialized')

  const opencodeConfigDir = await resolveOpencodeConfigDir(cfg)
  logger.info('[boot] resolved opencode config dir', {
    opencodeConfigDir,
    usingProjectConfig: opencodeConfigDir !== cfg.defaultOpencodeConfigDir,
  })

  // Satisfy the config dir's npm deps offline before opencode boots, so its
  // first-session `bun install` doesn't re-resolve `^` ranges over the network
  // (a 1.5–6s — sometimes minutes — stall that otherwise gates runtimeReady).
  await ensureOpencodeConfigDeps(opencodeConfigDir)
  bootMark('config-deps')

  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir, projectEnv)

  if (bootState.repoMaterializationError) {
    logger.warn('[boot] skipping opencode readiness because repo materialization failed')
  } else {
    // Now that the repo exists, pin the credential helper repo-locally too, so
    // `git push` authenticates regardless of the invoking shell's HOME (the
    // global config above only applies under HOME=<opencode home>).
    await configureRepoCredentialHelper(cfg, cfg.projectTarget).catch((err) => {
      logger.warn('[boot] repo-local git credential helper setup failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
    await opencode.start().catch((err) => {
      // opencode.start() throws only on a hard spawn failure; the supervisor
      // self-retries on transient issues. Log + continue: the proxy will 503
      // until the supervisor reports ready.
      logger.warn('[boot] opencode.start() rejected', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }
  bootMark('opencode-spawned')

  const server = startProxy(cfg, opencode, bootTime, bootState, projectEnv, staticWeb.port)
  installShutdownHandlers(opencode, server, staticWeb)
  bootMark('proxy-up')

  logger.info('[boot] proxy up; waiting for opencode readiness in background', {
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
        const res = await waitForInitialSessionCreate(
          `http://127.0.0.1:${cfg.opencodeInternalPort}`,
          process.env.KORTIX_WORKSPACE || '/workspace',
        )
        const session = (await res.json()) as { id?: string }
        if (session.id) {
          // Marker BEFORE the pin: the snapshot capture gates on the pin file
          // existing, so writing the marker first guarantees every fork that
          // inherits the pin also inherits the marker (else it can't rotate).
          markSeedBakedSession(session.id)
          mkdirSync(dirname(OPENCODE_SESSION_PIN_PATH), { recursive: true })
          writeFileSync(OPENCODE_SESSION_PIN_PATH, session.id, 'utf8')
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
        (process.env.KORTIX_INITIAL_PROMPT ?? '').trim().length > 0 ||
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
        if (!bootState.repoMaterializationError) await configureRepoCredentialHelper(cfg2, cfg2.projectTarget).catch(() => {})
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
async function startSessionRuntime(
  opencode: ReturnType<typeof createOpencodeSupervisor>,
  cfg: Config,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): Promise<void> {
  const onQuestionAsked = (req: QuestionRequest) => {
    void relayQuestionToApi(req, cfg).catch((err) =>
      logger.warn('[opencode-events] question relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionIdle = (opencodeSessionId: string) => {
    void relayTurnEndToApi(opencodeSessionId, 'idle', opencode, cfg).catch((err) =>
      logger.warn('[opencode-events] turn-end relay failed', { err: (err as Error).message }),
    )
  }
  const onSessionError = (opencodeSessionId: string, error?: OpencodeTurnError) => {
    void relayTurnEndToApi(opencodeSessionId, 'error', opencode, cfg, error).catch((err) =>
      logger.warn('[opencode-events] turn-end relay failed', { err: (err as Error).message }),
    )
  }
  const eventHandlers = { onQuestionAsked, onSessionIdle, onSessionError }
  if (bootState.initialOpenCodeSessionRequired) {
    await maybeCreateInitialOpencodeSession(cfg.opencodeInternalPort, bootState, bootMark).catch((err) => {
      bootState.initialOpenCodeSessionError = err instanceof Error ? err.message : String(err)
      logger.warn('[boot] initial opencode session setup failed', err)
    })
    if (bootState.initialOpenCodeSessionId) {
      opencode.markReady()
      bootMark('opencode-ready')
      logger.info('[boot] opencode ready via initial session', { opencodePid: opencode.getPid(), timeline: bootState.timeline })
      startOpencodeEventLoop(opencode, cfg, eventHandlers)
      return
    }
  }
  const ready = await waitForOpencodeReady(opencode, cfg.projectTarget, () => bootMark('opencode-listening'))
  if (ready) {
    bootMark('opencode-ready')
    logger.info('[boot] opencode ready', { opencodePid: opencode.getPid(), timeline: bootState.timeline })
    startOpencodeEventLoop(opencode, cfg, eventHandlers)
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
// `Authorization: Bearer <KORTIX_SANDBOX_TOKEN>` → `{ models: {...} }` ==
// gatewayModelCatalog(projectId, userId). During seed capture there is NO live
// sessionSandboxes row (it's a template build), and the token is a type='user'
// account key, so the route must authorize by validateAccountToken→accountId/projectId,
// NOT by the sandbox-row check clone-credential uses.
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
  await ensureOpencodeConfigDeps(opencodeConfigDir).catch(() => {})

  // Warm-fork NO-RESTART path (opt-in KORTIX_LLM_HOTSWAP=1; stateful warm
  // snapshots only — cold + Daytona never run it).
  // Start the localhost LLM credential proxy, and optionally the Executor proxy
  // used by the compatibility MCP face. The agent-facing Executor path is the
  // `kortix executor` CLI, which reads live env on each shell command and does
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
    const exPort = Number(process.env.KORTIX_EXECUTOR_PROXY_PORT) || 4320
    const exUrl = startExecutorProxy(exPort)
    if (exUrl) {
      // Seen by buildOpencodeConfigContent only when KORTIX_EXECUTOR_MCP_ENABLED=1.
      // The proxy is harmless when unused; the CLI remains the primary path.
      process.env.KORTIX_EXECUTOR_PROXY_URL = exUrl
      bootMark('seed-executor-proxy-started')
      logger.info('[seed] executor hot-swap proxy up for optional executor MCP compatibility', { exUrl })
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

  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir, projectEnv)
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
        const res = await waitForInitialSessionCreate(`http://127.0.0.1:${cfg.opencodeInternalPort}`, cfg.projectTarget)
        const session = (await res.json()) as { id?: string }
        if (session.id) {
          // Marker BEFORE the pin: the snapshot capture gates on the pin file
          // existing, so writing the marker first guarantees every fork that
          // inherits the pin also inherits the marker (else it can't rotate).
          markSeedBakedSession(session.id)
          mkdirSync(dirname(OPENCODE_SESSION_PIN_PATH), { recursive: true })
          writeFileSync(OPENCODE_SESSION_PIN_PATH, session.id, 'utf8')
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
      writeAgentEnvFile(createProjectEnvStore())
      const cfg2 = loadConfig()
      // Rebuild the proxy/control surface with the fork's cfg; the seed booted
      // tokenless or with seed-only credentials.
      server.reload(cfg2)
      bootState.initialOpenCodeSessionRequired =
        (process.env.KORTIX_INITIAL_PROMPT ?? '').trim().length > 0 ||
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
        if (!bootState.repoMaterializationError) await configureRepoCredentialHelper(cfg2, cfg2.projectTarget).catch(() => {})
      }

      // The seed opencode process is started before adoption, when it has no
      // session-scoped Executor/CLI/LLM env and may have started before the
      // project config dir exists. Restart it after adopting the fork env + repo so
      // OPENCODE_CONFIG_CONTENT includes the Executor MCP and project config.
      const adoptedOpencodeConfigDir = bootState.repoMaterializationError
        ? cfg2.defaultOpencodeConfigDir
        : await resolveOpencodeConfigDir(cfg2)
      await ensureOpencodeConfigDeps(adoptedOpencodeConfigDir).catch((err) =>
        logger.warn('[seed] adoption config deps failed', { err: (err as Error).message }),
      )
      // NO-RESTART fast path (opt-in, stateful warm-fork only): the seed baked a
      // session-independent opencode config routed through the localhost LLM +
      // executor proxies, so inject the per-session tokens LIVE and reuse the
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
        !bootState.repoMaterializationError
      ) {
        // LLM gateway: required for the session to function.
        setLlmProxyToken(process.env.KORTIX_LLM_API_KEY, process.env.KORTIX_LLM_BASE_URL)
        // Optional Executor MCP compatibility: if the seed enabled that face,
        // the running MCP points at this proxy. The CLI path does not need this;
        // it reads the live session env through BASH_ENV on every command.
        if (process.env.KORTIX_EXECUTOR_PROXY_URL && executorProxyBaseUrl() != null) {
          setExecutorProxyToken(process.env.KORTIX_EXECUTOR_TOKEN, process.env.KORTIX_API_URL)
        }
        if (llmProxyReady()) {
          hotSwapped = true
          bootMark('adopt-opencode-hotswapped')
          // Observability only: this confirms the optional executor proxy has a
          // live token. It does not assert that OpenCode registered MCP tools.
          if (executorProxyReady()) bootMark('adopt-executor-proxy-ready')
          logger.info('[seed] fork adoption hot-swap: per-session tokens injected via proxies, opencode not restarted', {
            executorReady: executorProxyReady(),
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
async function maybeCreateInitialOpencodeSession(
  opencodePort: number,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
): Promise<void> {
  const prompt = (process.env.KORTIX_INITIAL_PROMPT ?? '').trim()
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  if (!prompt && !bootstrapSession) return

  const baseUrl = `http://127.0.0.1:${opencodePort}`
  const workspace = process.env.KORTIX_WORKSPACE || '/workspace'

  let existing = await resolveExistingRoot(baseUrl, workspace)
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
    alreadyDelivered = existing.hasMessages
    logger.info('[boot] reusing existing opencode root', {
      sessionId,
      alreadyDelivered,
      lastTurnIncomplete: existing.lastTurnIncomplete,
    })
    // A turn interrupted by the restart left a part stuck "running"; finalize it
    // so a client streaming this root sees the turn end instead of spinning.
    if (existing.lastTurnIncomplete) await abortOpencodeTurn(baseUrl, workspace, sessionId)
  } else {
    logger.info('[boot] creating initial opencode session', {
      bytes: prompt.length,
      hasPrompt: prompt.length > 0,
      workspace,
    })
    const sessionRes = await waitForInitialSessionCreate(baseUrl, workspace)
    const session = (await sessionRes.json()) as { id?: string }
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
  bootState.initialOpenCodeSessionId = sessionId
  // Set the durable DB pin server-side now — Slack/trigger/cron sessions that no
  // browser ever opens otherwise kept a null pin, which forced a lazy resolution
  // that could land on the wrong root.
  void relayBootstrapPinToApi(sessionId)

  if (prompt && !alreadyDelivered) {
    const model = resolveOpencodeModel()
    const promptRes = await fetch(
      `${baseUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
          ...(model ? { model } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!promptRes.ok) {
      throw new Error(`opencode prompt failed: ${promptRes.status} ${await promptRes.text()}`)
    }
    logger.info('[boot] initial prompt delivered', { sessionId })
  } else if (prompt) {
    logger.info('[boot] initial prompt already delivered to reused root; not re-running', { sessionId })
  } else {
    logger.info('[boot] opencode root ready (bootstrap, no prompt)', { sessionId })
  }
  bootMark('opencode-session-created')
}

/** Best-effort write of the canonical opencode root id to the well-known pin
 *  file (the in-sandbox source of truth read by abort/relay/turn-end). */
function pinOpencodeSessionFile(sessionId: string): void {
  try {
    mkdirSync(dirname(OPENCODE_SESSION_PIN_PATH), { recursive: true })
    writeFileSync(OPENCODE_SESSION_PIN_PATH, sessionId, 'utf8')
  } catch (err) {
    logger.warn('[boot] failed to pin opencode session id', err)
  }
}

/** Record (at seed time) that the pinned root is the SEED's pre-baked one, so the
 *  first claiming fork rotates off it instead of sharing it. Captured into the
 *  snapshot next to the pin, so every fork inherits it. See opencode-fork-root.ts. */
function markSeedBakedSession(sessionId: string): void {
  try {
    mkdirSync(dirname(OPENCODE_SEED_BAKED_PIN_PATH), { recursive: true })
    writeFileSync(OPENCODE_SEED_BAKED_PIN_PATH, sessionId, 'utf8')
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

interface ExistingRoot { id: string; hasMessages: boolean; lastTurnIncomplete: boolean }

/**
 * Resolve a usable existing canonical root for this workspace so a restart
 * reuses it instead of creating a duplicate. Prefers the pinned id (if it still
 * exists as a root), else the most-recently-active root. Returns null when
 * opencode is unreachable or holds no root yet (the caller then creates one).
 */
async function resolveExistingRoot(baseUrl: string, workspace: string): Promise<ExistingRoot | null> {
  // Wait for a DEFINITIVE answer from opencode before deciding. Treating a slow
  // boot as "no roots" would create a duplicate on restart — the exact bug we're
  // killing — so only conclude "create a fresh root" once opencode has actually
  // answered with an empty list (or never answers within the deadline).
  const roots = await waitForRootList(baseUrl, workspace)
  if (!roots || roots.length === 0) return null
  const pinned = readPinnedOpencodeSessionId()
  const chosen = (pinned && roots.find((r) => r.id === pinned)) || pickMostRecentRoot(roots)
  if (!chosen) return null
  const inspection = await inspectRoot(baseUrl, workspace, chosen.id)
  return { id: chosen.id, hasMessages: inspection.hasMessages, lastTurnIncomplete: inspection.lastTurnIncomplete }
}

interface RootLite { id: string; created: number; updated: number }

/** Poll opencode's session list until it answers definitively (reachable),
 *  returning the roots it holds (possibly `[]`). Null only if opencode never
 *  became reachable within the deadline — so the caller never mistakes a slow
 *  boot for an empty workspace and creates a duplicate root. */
async function waitForRootList(baseUrl: string, workspace: string): Promise<RootLite[] | null> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const roots = await listOpencodeRoots(baseUrl, workspace)
    if (roots !== null) return roots
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

/** List opencode ROOT sessions (no parentID). Returns null when opencode is not
 *  reachable yet — distinct from `[]` (reachable, no sessions). */
async function listOpencodeRoots(baseUrl: string, workspace: string): Promise<RootLite[] | null> {
  try {
    const res = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(workspace)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
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

interface RootInspection { hasMessages: boolean; lastTurnIncomplete: boolean }

/** Does the root already have messages (prompt delivered), and is its last turn
 *  an assistant message left incomplete by a crash (no completion time)? */
async function inspectRoot(baseUrl: string, workspace: string, sessionId: string): Promise<RootInspection> {
  try {
    const res = await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    if (!res.ok) return { hasMessages: false, lastTurnIncomplete: false }
    const msgs = (await res.json()) as Array<{ info?: { role?: string; time?: { completed?: number } } }>
    if (!Array.isArray(msgs) || msgs.length === 0) return { hasMessages: false, lastTurnIncomplete: false }
    const last = msgs[msgs.length - 1]
    const incomplete = last?.info?.role === 'assistant' && !last?.info?.time?.completed
    return { hasMessages: true, lastTurnIncomplete: Boolean(incomplete) }
  } catch {
    return { hasMessages: false, lastTurnIncomplete: false }
  }
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
  const token = (
    process.env.KORTIX_CLI_TOKEN ||
    process.env.KORTIX_SANDBOX_TOKEN ||
    process.env.KORTIX_TOKEN ||
    ''
  ).trim()
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

async function waitForInitialSessionCreate(baseUrl: string, workspace: string): Promise<Response> {
  const url = `${baseUrl}/session?directory=${encodeURIComponent(workspace)}`
  const deadline = Date.now() + 20_000
  let lastError = 'opencode session create timed out'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(1_000),
      })
      if (res.ok) return res
      const body = await res.text().catch(() => '')
      lastError = `opencode session create failed: ${res.status} ${body}`
      if (res.status >= 400 && res.status < 500 && res.status !== 404) break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(lastError)
}

// The relay context for a SLACK-originated session, or null when this is not
// one. Slack sessions carry SLACK_* env injected by the dispatcher; the four
// KORTIX_* vars are what we need to reach apps/api. Everywhere else (the web
// dashboard, the CLI) this returns null so the sandbox stays out of the way and
// the opencode event is handled natively. Shared by the question + turn-end
// relays so BOTH gate on Slack identically — the question relay used to skip
// this gate, which auto-answered the `question` tool in non-Slack sessions.
function slackRelayContext(): { projectId: string; sessionId: string; token: string; apiRoot: string } | null {
  if (!(process.env.SLACK_THREAD_TS || process.env.SLACK_CHANNEL_ID)) return null
  const projectId = process.env.KORTIX_PROJECT_ID?.trim()
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  // /turn-stream accepts EITHER the session token or the sandbox credential
  // (it's a sandbox-identity route). Prefer the session token; fall back to the
  // sandbox credential — canonical name first, legacy KORTIX_TOKEN alias last.
  const token = (
    process.env.KORTIX_CLI_TOKEN ||
    process.env.KORTIX_SANDBOX_TOKEN ||
    process.env.KORTIX_TOKEN ||
    ''
  ).trim()
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

// Relay an opencode `question.asked` event for a SLACK session: post the
// question(s) into the thread and resume the agent's (blocking) `question` tool
// with a sentinel so the turn ends — the user's in-thread reply / button click
// arrives as a new turn.
//
// "Is this a Slack session?" is read straight from the sandbox env, which IS the
// session metadata: a Slack session is tagged `metadata.slack` at creation, and
// the API projects that into SLACK_THREAD_TS / SLACK_CHANNEL_ID on EVERY
// (re)provision (buildSessionChannelEnv). A web/dashboard session has no such
// metadata, so it has no such env — `slackRelayContext()` returns null and we
// return WITHOUT touching opencode's question. That's the whole fix: the
// dashboard answers `question.asked` interactively over opencode's own SSE, and
// auto-answering it here was the "every question is auto-answered even outside
// Slack" bug. No round-trip, no status codes — the env is the source of truth.
async function relayQuestionToApi(req: QuestionRequest, cfg: Config): Promise<void> {
  const ctx = slackRelayContext()
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

  // Resume opencode's (blocking) question tool with a sentinel so the turn ends;
  // the user's reply / button click lands as a new turn. ALWAYS reply — a Slack
  // question must never hang (that was "stuck until I kill it manually").
  const sentinel =
    '(Posted to the Slack thread. In Slack, questions are async — the user replies ' +
    'as a normal message, which reaches you as a NEW turn with full context. Do NOT ' +
    'wait for an answer here; finish this turn now. Next time, just ask with ' +
    '`slack send` rather than the question tool.)'
  const answers: string[][] = req.questions.map(() => [sentinel])
  const replyUrl = `http://127.0.0.1:${cfg.opencodeInternalPort}/question/${encodeURIComponent(req.id)}/reply?directory=${encodeURIComponent(cfg.workspace)}`
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
// turn to apps/api so the Slack live stream gets closed even when the agent
// ends without `slack send`. Without this, abandoned streams sit until Slack's
// inactivity timeout paints them as "Something went wrong" — a finished turn
// that looks like a failed one. opencode fires these events for every session —
// including subagent (Task tool) children — so we ignore any whose sessionID
// isn't the root turn session. Only relevant for Slack-originated sessions
// (SLACK_* env is injected by the Slack dispatcher); a no-op everywhere else.
async function relayTurnEndToApi(
  opencodeSessionId: string,
  status: 'idle' | 'error',
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
  eventError?: OpencodeTurnError,
): Promise<void> {
  const ctx = slackRelayContext()
  if (!ctx) return
  // Only the ROOT turn closes the Slack stream — a subagent going idle mid-task
  // must NOT finalize the user-facing stream. Detected by parentID (objective),
  // not pin-equality, so an orphaned-root re-pin can't filter out the real idle.
  if (!(await isRootOpencodeSession(opencodeSessionId, opencode, cfg))) return

  // Resolve the turn's error. session.error already hands us one; an idle end
  // (e.g. retries exhausted, then idle) carries none, so read the root turn's
  // last assistant message — exactly what the web UI shows — and upgrade idle→
  // error when it failed. This is what turns a blank "ended without a reply" in
  // Slack into "out of credits" / rate-limit / the real error.
  const error = eventError ?? (await readRootTurnError(opencodeSessionId, opencode, cfg))
  const effectiveStatus = error ? 'error' : status

  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
  const payload = JSON.stringify({
    session_id: sessionId,
    kind: 'end',
    status: effectiveStatus,
    opencode_session_id: opencodeSessionId,
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

// Read the ROOT turn's failure, if any, from its last assistant message — the
// same `AssistantMessage.error` the web UI renders. opencode's session.error
// event already carries this for a hard failure, but a run that exhausts retries
// (e.g. out of credits / rate-limited) can end on `session.idle` with the error
// only on the message; this is what lets Slack still say *why* instead of going
// silent. Best-effort: any miss/parse failure returns undefined (treated as a
// clean end), so this never turns a healthy turn into a phantom failure.
async function readRootTurnError(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<OpencodeTurnError | undefined> {
  try {
    const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/message?directory=${encodeURIComponent(cfg.workspace)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return undefined
    const rows = (await res.json()) as Array<{
      info?: {
        role?: string
        error?: {
          name?: string
          data?: { message?: string; statusCode?: number; isRetryable?: boolean; providerID?: string }
        }
      }
    }>
    if (!Array.isArray(rows)) return undefined
    // The most recent assistant message decides the turn's outcome. Crucially,
    // stop at the turn boundary: if a USER message is the newest row (a pending or
    // follow-up turn that hasn't produced an assistant reply yet), treat the run
    // as clean — never walk back into a PRIOR turn's already-superseded error and
    // relay it as this turn's failure.
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info
      if (info?.role === 'user') return undefined
      if (info?.role !== 'assistant') continue
      return info.error ? flattenOpencodeError(info.error) : undefined
    }
    return undefined
  } catch {
    return undefined
  }
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

/** Per-session model override from KORTIX_OPENCODE_MODEL. Most models use
 *  provider/model form and are returned in OpenCode's `{ providerID, modelID }`
 *  shape. Bare legacy Zen ids are normalized onto the OpenCode provider so old
 *  queued boot prompts keep using the schema accepted by `prompt_async`. */
export function resolveOpencodeModel(): { providerID: string; modelID: string } | undefined {
  const raw = (process.env.KORTIX_OPENCODE_MODEL ?? '').trim()
  if (LEGACY_OPENCODE_ZEN_FREE_MODELS.has(raw)) return { providerID: 'opencode', modelID: raw }
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  const providerID = raw.slice(0, slash)
  const modelID = raw.slice(slash + 1)
  return { providerID, modelID }
}

/** Read the pinned opencode session id (set at boot when KORTIX_INITIAL_PROMPT
 *  was delivered). Returns null if no session was pinned — caller decides
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
  } else {
    main().catch((err) => {
      logger.error('[boot] fatal', err)
      process.exit(1)
    })
  }
}
