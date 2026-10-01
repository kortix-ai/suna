import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from '@/lib/log/logger'
import { writeAgentEnvFile } from '../shared/agent-env-file'
import { configureGlobalGitIdentity, configureGitCredentialHelper, configureRepoCredentialHelper, materializeRepo, materializeProjectSeed, materializeScaffoldSeed, scheduleHistoryBackfill } from '@/lib/git/git'
import { loadOpenCodeConfig as loadConfig, type OpenCodeConfig as Config } from './config'
import { waitForOpencodeReady, refreshGatewayCatalogFile } from './lifecycle'
import { bootOpenCodeConfig } from './boot-config-path'
import { OPENCODE_HOME } from './paths'
import { createProjectEnvStore } from '@/services/sandbox-env/project-env'
import { startEgressShim } from '@/services/egress-shim'
import { startLlmProxy, setLlmProxyToken, llmProxyReady, llmProxyBaseUrl, startConnectorProxy, setConnectorProxyToken, connectorProxyReady, connectorProxyBaseUrl } from '@/services/llm-proxy/llm-proxy'
import { createOpenCodeHarnessService } from './service'
import { finalizeOrphanedTurn, markSeedBakedSession } from './initial-session'
import { createInitialOpenCodeSession } from './initial-prompt'
import { openAssistantMessageIdOnRoot } from './opencode-turn-state'
import { readOpenCodeSessionPin, writeOpenCodeSessionPin } from './runtime-state'
import type { OpenCodeBootState as SandboxBootState } from './boot-state'
import type { HarnessBootContext } from '../harness'
import type { OpenCodeHarnessService } from './service'
import type { DaemonServer } from '../contract/server'

// Read KEY=VALUE lines from the per-session env file into process.env. Platinum
// restore writes it directly into the guest pre-boot at /etc/pt-env (host-agent
// writeEnvIntoOverlay via debugfs / writeGuestEnv).
export function reloadSessionEnv(paths: string[] = ['/etc/pt-env']): void {
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

export async function runWarmSeedMode(
  cfg: Config,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  serve: HarnessBootContext['serve'],
  startSessionRuntime: (harness: OpenCodeHarnessService, cfg: Config, bootState: SandboxBootState, bootMark: (label: string) => void) => Promise<void>,
): Promise<void> {
  const projectEnv = createProjectEnvStore()
  writeAgentEnvFile(projectEnv)

  // Scaffold-warm the seed: materialize the image-baked scaffold at /workspace
  // (zero-network) so opencode pays its per-directory project init (git scan +
  // file index + LSP + sqlite) ONCE here, FROZEN into the snapshot. Without this
  // every fork paid that ~3.2s init on its own hot path (the runtime-ready
  // wall). Resolve opencode's config from the scaffold's config dir so the
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

  const harness = createOpenCodeHarnessService(cfg, projectEnv, {
    onStartupMark: bootMark,
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
  // The warm-seed BUILDER has no session and no API to ask, so the one boot
  // path takes its legacy branch by construction: OpenCode reads the scaffold's
  // own config dir, through the boot link like every other spawn. The fork that
  // adopts this snapshot runs the whole path again and lands on the project's
  // current release.
  await bootOpenCodeConfig({
    cfg,
    opencode,
    api: null,
    workspace: Promise.resolve(materialized ? null : 'no seed repository materialized'),
    mark: bootMark,
    start: async () => {
      await opencode
        .start()
        .catch((err) => logger.warn('[seed] opencode.start() rejected', { err: err instanceof Error ? err.message : String(err) }))
      bootMark('seed-opencode-spawned')
      await opencode.waitForCurrentListening()
    },
    respawn: async () => {
      await opencode.restart({ finalizeTurn: false }).catch(() => {})
      await opencode.waitForCurrentListening()
    },
    onReady: () => {
      bootState.workspaceReady = true
    },
  })
  const { server } = serve(harness, projectEnv)
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
        // The fork is a START of this box, so it runs the SAME one boot path a
        // fresh boot does — it asks the API what to run, proves it, and only
        // then reports ready. The seed's own config never decides a fork's.
        harness.configuration.reconfigure(cfg2, projectEnv)
        await bootOpenCodeConfig({
          cfg: cfg2,
          opencode,
          workspace: Promise.resolve(bootState.repoMaterializationError ?? null),
          mark: bootMark,
          start: async () => {},
          respawn: async () => {
            await opencode.restart().catch((err) =>
              logger.warn('[seed] adoption opencode restart failed', { err: (err as Error).message }),
            )
            await opencode.waitForCurrentListening()
          },
          onReady: () => {
            bootState.workspaceReady = true
          },
        })
        bootMark('adopt-opencode-restarted')
      }
      await startSessionRuntime(harness, cfg2, bootState, bootMark)
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


// Adopt a forked session inside a warm-seed clone. The repo is already baked —
// materializeRepo() takes its local-only branch (remote set-url + `checkout -B
// <session>`), so adoption is ~100ms.
// Trigger: KORTIX_SESSION_ID appearing in /etc/pt-env (the seed's own env
// never contains it — platinum-seed.ts strips it from captureEnv).
export function armSeedAdoption(
  harness: OpenCodeHarnessService,
  server: DaemonServer,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  startSessionRuntime: (harness: OpenCodeHarnessService, cfg: Config, bootState: SandboxBootState, bootMark: (label: string) => void) => Promise<void>,
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
      await startSessionRuntime(harness, cfg2, bootState, bootMark)
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
