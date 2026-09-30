import type { HarnessControlService, HarnessControlOperations, HarnessEnvironmentInput, HarnessRefreshInput } from '../contract/control'
import { requireOpenCodeConfig, type OpenCodeConfig } from './config'
import { convergeConfigRelease, isConvergenceInFlight, releaseGovernanceActive } from './config-release'
import { writeAgentEnvFile } from '../shared/agent-env-file'
import { syncEgressShim } from '@/services/egress-shim'
import { invalidateRuntimeState } from './runtime-state-projection'
import { noteOpencodeStopRequested } from './instance-guard'
import { scheduleRuntimeProjectionPush } from '../shared/projection-relay'
import { llmProxyBaseUrl, setLlmProxyToken } from '@/services/llm-proxy/llm-proxy'
import { logger } from '@/lib/log/logger'
import { convergeManagedModelCatalog, requiresRespawn, type Opencode } from './lifecycle'
import { reconcileProjectEnv } from '@/services/sandbox-env/project-env'
import { readRepoInfo, refreshRepo, syncConfigDirToBase, syncWorkspaceToBase, type ConfigDirSyncResult } from '@/lib/git/git'
import { readBootLinkTarget } from '@/services/config-release/boot-config'
import { scheduleRuntimeAssetsReconcile } from '@/services/runtime-assets/runtime-assets'
import { opencodeTurnInFlight } from './opencode-turn-state'
import {
  readOpenCodeSessionPin,
  readOpencodeRuntimeEnvSnapshot,
  writeOpencodeRuntimeEnvSnapshot,
} from './runtime-state'
import type { QuickQueueInterrupt } from './quick-queue-interrupt'

const OPENCODE_RUNTIME_ENV_NAMES = new Set([
  'KORTIX_LLM_BASE_URL',
  // The daemon-local LLM proxy URL (warm-fork boxes). Cleared on a live
  // gateway→native toggle — hasKortixLlmGateway() treats a set proxy URL as
  // "gateway on", so leaving it behind would pin the box in gateway mode.
  'KORTIX_LLM_PROXY_URL',
  // The session's model. opencode reads this when it builds its config at spawn
  // (opencode.ts), so accepting it here + restarting is what makes a mid-session
  // model change take effect on a box that is already up.
  'KORTIX_OPENCODE_MODEL',
  // Its harness-neutral name (D3). The API sends both for one release.
  'KORTIX_MODEL',
  // Channel sessions can opt into the Connector MCP face after a deploy. This
  // must restart OpenCode because MCP servers are registered only at spawn.
  'KORTIX_CONNECTORS_MCP_ENABLED',
  // The server-compiled agent config (agents, prompts, permissions, model) —
  // apps/api's compile-agent-config.ts output.
  //
  // Until this was allowlisted it was the ONE piece of config with no way into
  // a running box. It is compiled from git once, at provision, and handed down
  // as an env var, so a restart re-read the daemon's unchanged env and rebuilt
  // the same stale bytes: `git pull` updated the working tree, the agent's
  // behaviour did not, and nothing short of a new session reconciled the two.
  // Same mechanism as the model above — accept it, then restart.
  'KORTIX_COMPILED_AGENT_CONFIG',
  // Its content hash, echoed by /kortix/health so a client can ask what this box
  // is really running. Pushed with the config; allowlisted so the two cannot
  // drift apart on a live update.
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
  'KORTIX_SECRET_CAPABILITIES',
])

/**
 * Owned by a config release while one is active (config-release.ts). A push
 * of these names is ignored then, so the release's governance stays the one
 * the next spawn composes.
 */
const RELEASE_OWNED_ENV_NAMES = new Set(['KORTIX_COMPILED_AGENT_CONFIG', 'KORTIX_COMPILED_AGENT_CONFIG_ETAG'])

/**
 * The subset of `OPENCODE_RUNTIME_ENV_NAMES` whose amnesia across a daemon
 * restart this module protects against — every one EXCEPT the two release
 * governs. A release re-establishes its own two on every boot through
 * `convergeConfigRelease` (config-release.ts), which is a more authoritative,
 * independently-scheduled source; seeding a stale snapshot value ahead of it
 * would only risk racing that path for no benefit. The rest
 * (`KORTIX_SECRET_CAPABILITIES` foremost) have no such re-derivation and are
 * delivered ONLY by a live `/kortix/env` push — see `writeOpencodeRuntimeEnvSnapshot`.
 */
const PERSISTED_OPENCODE_ENV_NAMES = [...OPENCODE_RUNTIME_ENV_NAMES].filter(
  (name) => !RELEASE_OWNED_ENV_NAMES.has(name),
)

/**
 * Persist the CURRENT full picture of the protected names, so a later daemon
 * restart restores it. Called only when something in this push actually
 * changed `process.env` — an unchanged push has nothing new to persist.
 */
function persistOpencodeRuntimeEnvSnapshot(): void {
  const snapshot: Record<string, string> = {}
  for (const name of PERSISTED_OPENCODE_ENV_NAMES) {
    const value = process.env[name]
    if (typeof value === 'string') snapshot[name] = value
  }
  writeOpencodeRuntimeEnvSnapshot(snapshot)
}

/**
 * Restore the persisted runtime-env snapshot into THIS process's env, for
 * every protected name it does not already hold. Called once, at boot,
 * before OpenCode's first spawn — see boot.ts's `runOpenCode`.
 *
 * Never overrides a name the box's OWN boot path already set: only fills the
 * gap for a name whose sole source of truth is a live push, so the next
 * `/kortix/env` push of an UNCHANGED value reads as unchanged, not as a
 * config-affecting delta that forces an avoidable respawn.
 */
export function restoreOpencodeRuntimeEnvSnapshotIfUnset(): void {
  const snapshot = readOpencodeRuntimeEnvSnapshot()
  const restored: string[] = []
  for (const name of PERSISTED_OPENCODE_ENV_NAMES) {
    const value = snapshot[name]
    if (typeof value !== 'string') continue
    if (process.env[name] !== undefined) continue
    process.env[name] = value
    restored.push(name)
  }
  if (restored.length > 0) {
    logger.info('[env] restored the last-applied opencode runtime env across a daemon restart', {
      names: restored.sort(),
    })
  }
}

/**
 * Is a config-affecting opencode respawn ALLOWED to promote right now?
 *
 * The one predicate every `mustRespawn: true` caller in this file must supply
 * as `mayPromote` — see `Opencode.reloadConfig`'s doc. "Cannot tell" counts as
 * busy, the same rule `opencodeTurnInFlight` documents and `runtime-assets.ts`
 * applies to the agent-swap path: an update is never worth guessing about,
 * because the alternative to promoting now is promoting at the next trigger.
 */
function opencodeEnvRestartMayPromote(
  opencode: Pick<Opencode, 'getInternalUrl'>,
  workspace: string,
): Promise<boolean> {
  return opencodeTurnInFlight(opencode.getInternalUrl(), workspace).then((turnInFlight) => turnInFlight === false)
}

/**
 * A config-affecting `/kortix/env` respawn that `mayPromote` declined because
 * a turn was running (or its state was unreadable) when the candidate was
 * ready to promote.
 *
 * Set by `applyEnvironment`, cleared and retried by
 * `retryDeferredOpencodeEnvRestart` — called from the daemon's own
 * `session.idle` frame (boot.ts's `onSessionIdle`), the one moment this
 * daemon knows for certain that nothing is running. Per-process, like
 * `runtime-assets.ts`'s own pending-swap state: there is exactly one running
 * opencode per sandbox, so one flag is the whole state machine.
 */
let opencodeEnvRestartPending = false

/** Test seam: clear the pending flag between rows. */
export function resetOpencodeEnvRestartPendingForTests(): void {
  opencodeEnvRestartPending = false
}

/** Test seam: is a deferred restart currently pending? */
export function opencodeEnvRestartIsPendingForTests(): boolean {
  return opencodeEnvRestartPending
}

/**
 * Retry a config-affecting opencode respawn that a live turn deferred.
 *
 * A no-op when nothing is pending. Never throws: a failed retry leaves the
 * flag set so the NEXT idle boundary tries again, and the box otherwise runs
 * on unchanged.
 */
export async function retryDeferredOpencodeEnvRestart(
  opencode: Pick<Opencode, 'reloadConfig' | 'getInternalUrl'>,
  workspace: string,
): Promise<void> {
  if (!opencodeEnvRestartPending) return
  opencodeEnvRestartPending = false
  logger.info('[env] retrying a config-affecting opencode restart deferred by a live turn')
  try {
    const applied = await opencode.reloadConfig({
      mustRespawn: true,
      mayPromote: () => opencodeEnvRestartMayPromote(opencode, workspace),
    })
    if (applied.how === 'kept-old') {
      // Still busy, or the config still cannot boot — try again at the next
      // idle boundary rather than dropping the pending restart.
      opencodeEnvRestartPending = true
      logger.info('[env] deferred opencode restart still could not promote', { how: applied.how })
    }
  } catch (err) {
    opencodeEnvRestartPending = true
    logger.warn('[env] deferred opencode restart retry threw', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

function applyOpencodeRuntimeEnv(input: unknown): { changed: boolean; names: string[] } {
  if (input === undefined) return { changed: false, names: [] }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('opencodeEnv must be an object')
  }

  const changedNames: string[] = []
  const releaseOwned = releaseGovernanceActive()
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim().toUpperCase()
    if (!OPENCODE_RUNTIME_ENV_NAMES.has(name)) continue
    if (releaseOwned && RELEASE_OWNED_ENV_NAMES.has(name)) {
      logger.info('[env] compiled governance push ignored; the config release owns it', { name })
      continue
    }
    if (rawValue === null) {
      if (process.env[name] !== undefined) {
        delete process.env[name]
        changedNames.push(name)
      }
      continue
    }
    if (typeof rawValue !== 'string') continue
    if (process.env[name] !== rawValue) {
      process.env[name] = rawValue
      changedNames.push(name)
    }
  }

  return { changed: changedNames.length > 0, names: changedNames.sort() }
}

function setOpencodeRuntimeEnv(next: Record<string, string | null>): { changed: boolean; names: string[] } {
  const changedNames: string[] = []
  for (const [name, value] of Object.entries(next)) {
    if (!OPENCODE_RUNTIME_ENV_NAMES.has(name)) continue
    if (value === null) {
      if (process.env[name] !== undefined) {
        delete process.env[name]
        changedNames.push(name)
      }
      continue
    }
    if (process.env[name] !== value) {
      process.env[name] = value
      changedNames.push(name)
    }
  }
  return { changed: changedNames.length > 0, names: changedNames.sort() }
}

function applyLlmGatewayMode(enabled: unknown, baseUrl: unknown): { changed: boolean; names: string[] } {
  if (enabled === undefined) return { changed: false, names: [] }
  if (typeof enabled !== 'boolean') throw new Error('llmGatewayEnabled must be a boolean')
  if (!enabled) {
    return setOpencodeRuntimeEnv({
      KORTIX_LLM_BASE_URL: null,
      // Warm-fork boxes run a localhost LLM proxy and mark it here; it also
      // reads as "gateway on" (hasKortixLlmGateway), so a live disable must
      // clear both or the respawned opencode keeps the kortix provider.
      KORTIX_LLM_PROXY_URL: null,
    })
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('llmGatewayBaseUrl is required when llmGatewayEnabled is true')
  }
  const token = process.env.KORTIX_TOKEN
  if (!token) {
    throw new Error('KORTIX_TOKEN is unavailable; cannot enable LLM gateway in this running sandbox')
  }
  // A running localhost LLM proxy (every gateway session since the in-sandbox
  // image window) learns the new upstream + token and stays the provider
  // base URL; a box that never started one keeps the direct config.
  const proxyUrl = llmProxyBaseUrl()
  if (proxyUrl && process.env.KORTIX_LLM_PROXY_DISABLE !== '1') {
    setLlmProxyToken(token, baseUrl)
    return setOpencodeRuntimeEnv({
      KORTIX_LLM_BASE_URL: baseUrl,
      KORTIX_LLM_PROXY_URL: proxyUrl,
    })
  }
  return setOpencodeRuntimeEnv({
    KORTIX_LLM_BASE_URL: baseUrl,
  })
}

/** `repo=0`: report the checkout as it is; nothing is fetched or pulled. */
/**
 * `syncConfigDirToBase` on the config dir OpenCode actually reads, when that
 * dir is inside this checkout. A config release, or no project config dir at
 * all, leaves nothing in the working tree to bring forward.
 */
async function syncServedConfigDir(cfg: OpenCodeConfig, baseSha?: string): Promise<ConfigDirSyncResult> {
  const served = await readBootLinkTarget()
  if (!served || !served.startsWith(`${cfg.projectTarget}/`)) {
    return { synced: false, skipped: 'no tracked config dir' }
  }
  return syncConfigDirToBase(cfg, served.slice(cfg.projectTarget.length + 1), baseSha)
}

async function unchangedRepo(projectTarget: string) {
  const info = await readRepoInfo(projectTarget)
  if (!info) throw new Error('project repo is not materialized')
  return { before: info, after: info }
}

/** Native control operations. HTTP parsing, authorization and status mapping stay in routes. */
export function createOpenCodeControlService(
  opencode: Opencode,
  quickQueue: Pick<QuickQueueInterrupt, 'arm' | 'disarm'>,
): HarnessControlService {
  return {
    convergenceInFlight: () => isConvergenceInFlight(),
    bind(context): HarnessControlOperations {
      const { projectEnv, agentEnvFile } = context
      // Resolve the current config on each app rebuild, including warm adoption.
      const cfg = requireOpenCodeConfig(context.cfg)
      return {
        async applyEnvironment(body: HarnessEnvironmentInput) {
          if (!projectEnv) throw new Error('project env store is unavailable')
          const result = projectEnv.apply({
            revision: body.revision,
            env: body.env as Record<string, unknown>,
            names: body.names,
          })
          // PTYs and other daemon children inherit process.env directly. Keep it
          // aligned with the authoritative store so a new child cannot inherit a
          // revoked boot secret before it sources agent-env.sh.
          reconcileProjectEnv(process.env, projectEnv)
          const opencodeEnv = applyOpencodeRuntimeEnv(body.runtimeEnv)
          const llmGatewayEnv = applyLlmGatewayMode(body.llmGatewayEnabled, body.llmGatewayBaseUrl)
          // null when no reload was needed at all; otherwise how it was applied.
          let reloadOutcome: 'disposed' | 'restarted' | 'kept-old' | null = null
          // Whether applying the config interrupted work someone was waiting on.
          // null = no reload happened, or the box could not tell.
          let reloadTurnEnded: boolean | null = null
          const opencodeEnvChanged = opencodeEnv.changed || llmGatewayEnv.changed
          const opencodeEnvNames = [...new Set([...opencodeEnv.names, ...llmGatewayEnv.names])].sort()
          // Persist the new baseline BEFORE anything below might respawn or
          // crash: a daemon that dies mid-reload must not lose the record of
          // what it just applied, or the amnesia this closes reopens on the
          // very push that triggered it.
          if (opencodeEnvChanged) persistOpencodeRuntimeEnvSnapshot()

          if (result.changed) {
            logger.info('[env] project env changed; refreshing live agent env file', {
              revision: result.revision,
              names: result.names.length,
            })
          }
          // The capability catalog applied just above is also what arms the
          // in-guest egress shim, and boundary rules can move on a LIVE box:
          // adding the session's first network-boundary secret has to start a
          // listener that boot decided this session did not need.
          //
          // Ordered exactly as boot and fork adoption order it — shim first, then
          // writeAgentEnvFile — because that file is how the proxy + CA variables
          // reach the agent's shells, and it is equally what CLEARS them when the
          // last boundary secret goes away.
          //
          // Not fatal, by the same rule the boot path follows: a listener that
          // will not come up is a boundary secret that will not work, not a
          // reason to drop the project secrets, model and gateway mode arriving
          // in the same body. Nothing further down consults the outcome — a
          // catalog change is already respawn-required (opencode.ts), so the
          // reload below picks the new proxy env up on its own.
          const egressShim = await syncEgressShim().catch((err) => {
            logger.error('[env] egress shim sync failed', err)
            return { outcome: 'failed' as const, hosts: [] as readonly string[] }
          })
          // Always rewrite the shell artifact, including an identical revision.
          // A warm-fork race can leave agent-env.sh stale while the in-memory
          // store already has the requested revision. A sync replay must repair it.
          const agentEnvWritten = writeAgentEnvFile(projectEnv, { sh: agentEnvFile })
          if (!agentEnvWritten) throw new Error('failed to write live agent env file')
          if (body.refreshModels === true && (result.changed || opencodeEnvChanged)) {
            // reloadConfig, not restart: opencode re-reads its config file in
            // place via /global/dispose in ~51ms, against ~8s for a respawn
            // (measured on 1.17.11, dispose re-verified on the pinned 1.18.19).
            // It falls back to a restart on its
            // own if dispose is unavailable, so this is never less correct — only
            // faster, and it does not sever an in-flight turn when dispose wins.
            // Some values are consumed by `spawnChild` OUTSIDE the config file —
            // the deny-list shapes the child's env, and the Codex/OpenCode auth
            // secrets are materialized into ~/.local/share/opencode/auth.json. A
            // dispose re-reads the config file and touches neither, so it would
            // leave the OLD subscription credential on disk while reporting
            // success. That was a real regression from the dispose fast path:
            // connecting a ChatGPT account confirmed in the UI and the next turn
            // still ran on the account it replaced.
            //
            // Keyed on the value DELTA, not the allowlist — `result.names` is the
            // full set, so using it would respawn on every push for any project
            // that merely has one of these secrets.
            //
            // Project secrets (the `result.changedNames` half) shape the opencode
            // child's PROCESS env at spawn via `mergeProjectEnv` (opencode.ts) —
            // they are NOT in the config file a dispose re-reads. So any non-empty
            // `changedNames` means opencode's process env is stale and a dispose
            // would report success while the PID kept the old (e.g. 0/47) set. The
            // only correct reload for a project-secret delta is a full respawn.
            // The ~8s cost is the price of correctness; the dispose fast path is
            // preserved for pure model/auth/deny changes that touch no project
            // secret. Revocation is preserved too: `knownNames` is tracked in the
            // store, so a respawn clears a dropped secret via `mergeProjectEnv`.
            const projectSecretsMoved = result.changedNames.length > 0
            const mustRespawn = projectSecretsMoved || requiresRespawn(opencodeEnvNames)
            // The LAST check before the candidate is promoted — asked again
            // right there by reloadVerified, seconds after this one, closing
            // the TOCTOU a single check here cannot. Only meaningful when
            // mustRespawn is true: the dispose path never retires a process,
            // so it cannot sever a turn. Never omit this on a respawn: without
            // it a config push can promote a candidate and SIGTERM the
            // process a turn was just accepted on (2026-09-29 incident —
            // KORTIX_SECRET_CAPABILITIES pushed fleet-wide by a release; the
            // agent swap path (`runtime-assets.ts`) has deferred on
            // turn-in-flight for this same reason since it shipped).
            const applied = await opencode.reloadConfig({
              mustRespawn,
              mayPromote: mustRespawn ? () => opencodeEnvRestartMayPromote(opencode, cfg.workspace) : undefined,
            })
            const how = applied.how
            reloadTurnEnded = applied.turnEnded
            // 'kept-old' means the verified swap declined: the new opencode never
            // came up, so the running one was left serving. The config did NOT
            // take, and the caller has to be told — logging it here and returning
            // ok:true would report a reload that silently did nothing.
            reloadOutcome = how
            // A respawn that was declined because a turn was running (or its
            // state could not be told) is not abandoned — the box's own
            // `session.idle` frame retries it (see `retryDeferredOpencodeEnvRestart`,
            // wired from boot.ts's onSessionIdle). Never retried on a timer: a
            // timer near a promotion decision is what the config-releases AST
            // tripwires forbid, and this is the same class of decision.
            if (mustRespawn && how === 'kept-old') {
              opencodeEnvRestartPending = true
            }
            logger.info('[env] config-affecting env changed; applied to opencode', {
              projectRevision: result.revision,
              projectEnvChanged: result.changed,
              opencodeEnvNames,
              how,
              mustRespawn,
              deferred: mustRespawn && how === 'kept-old',
            })
          }

          // The daemon OWNS this write, so the projection is told rather than
          // left to infer it. `/kortix/opencode/state` serves the agent roster,
          // command list and config essentials this env change can move; a
          // client that read it a second ago must not keep the pre-change answer
          // until an SSE frame happens to hint at it.
          invalidateRuntimeState('all', 'kortix-env-applied')
          // ...and the server-side copy is refreshed too (debounced, etag-gated).
          scheduleRuntimeProjectionPush('kortix-env-applied')

          const applied = projectEnv.snapshot()
          const exported = Object.keys(applied.env).length
          logger.info('[env] project env applied', {
            revision: applied.revision,
            managed: applied.knownNames.length,
            current: applied.names.length,
            exported,
            withheld: Math.max(0, applied.knownNames.length - exported),
            agentEnvWritten,
            egressShim: egressShim.outcome,
          })

          return {
            ok: true,
            changed: result.changed,
            revision: result.revision,
            names: result.names,
            exported,
            managed: applied.knownNames.length,
            withheld: Math.max(0, applied.knownNames.length - exported),
            agent_env_written: agentEnvWritten,
            // 'unchanged' | 'started' | 'restarted' | 'stopped' | 'failed'.
            // 'failed' is the one a caller must surface: the secret saved, the
            // catalog landed, and the credential still will not be injected.
            egress_shim: egressShim.outcome,
            egress_shim_hosts: egressShim.hosts,
            runtime_env_changed: opencodeEnvChanged,
            runtime_env_names: opencodeEnvNames,
            runtime: opencode.getState(),
            runtime_pid: opencode.getPid(),
            // 'disposed' | 'restarted' | 'kept-old' | null (no reload needed).
            // 'kept-old' is the verified swap declining a config that would not
            // boot — a successful safety outcome, and a FAILED reload.
            runtime_reload: reloadOutcome,
            runtime_turn_ended: reloadTurnEnded,
          }
        },
        async refresh({ syncBase, skipRestart, skipRepo, syncBaseConfig, baseSha, forceFail }: HarnessRefreshInput) {
          const repo = syncBase
            ? await syncWorkspaceToBase(cfg, baseSha)
            : skipRepo
              ? await unchangedRepo(cfg.projectTarget)
              : await refreshRepo(cfg)
          // A project without config releases runs the agent files in this
          // checkout, and a fast-forward of the session branch never brings the
          // base branch's changes to them (prod 2026-09-30: an agent `.md` fix
          // merged to main never reached a live session, through two reloads).
          const configDir = syncBaseConfig && !syncBase ? await syncServedConfigDir(cfg, baseSha) : undefined
          // Verified swap, not a kill-then-hope restart: boot the new opencode,
          // prove it serves, and only then retire the running one. A config that
          // cannot boot leaves the session on the opencode it already had.
          // `?verify_fail=1` — fault injection for the reload's SAFETY path.
          //
          // The decline branch (candidate does not boot → keep the running
          // opencode, report why) cannot otherwise be reached on a real box: the
          // API validates agent configs against opencode's schema before they
          // reach a sandbox, so no supported input produces one that fails to
          // start. Without this the branch is provable only in unit tests.
          //
          // Safe to expose. Its entire effect is the reload DECLINING — the same
          // outcome the mechanism produces on a genuine failure. The session
          // keeps the opencode it already had, nothing is destroyed, and the
          // response says plainly that the config did not take.
          const reload = skipRestart && configDir?.synced !== true
            ? null
            : await opencode.reloadVerified({ forceFail })
          // Converge the sandbox's `kortix` CLI + managed-skill overlay on this
          // API. This route is what the platform already calls on warm reuse and
          // reload, and (since this change) after a restart and a resume — the
          // three moments a long-lived box comes back up without re-running its
          // image build. Detached on purpose: the route's callers await its
          // latency, and a ~100 MB download must never enter that budget. The
          // reconcile is single-flighted, so a burst of refreshes runs one pass.
          //
          // NEVER while OpenCode is still booting. The API calls this route from
          // the session-open path (env-sync) — on a resume that is BEFORE the
          // runtime is ready — and a pass that finds a stale pin installs the
          // new OpenCode and restarts it underneath the boot in progress
          // (2026-08-25 17:23: install at +9 s, spawn at +13 s, the
          // API's start budget expired on both boxes). main.ts schedules the
          // post-boot pass itself once `opencode-ready` is marked; this call is
          // for a box that is already up.
          if (opencode.getState() === 'ok') {
            scheduleRuntimeAssetsReconcile(cfg)
            // NON-BLOCKING catalog reconcile — same three moments as the line
            // above (warm reuse, reload, and a resume/wake), and the reason
            // this exists: a box woken after the managed lineup moved kept
            // answering ModelNotFound for the platform's own current models
            // because nothing on the wake path ever re-applied the overlay.
            // Detached and file-only — never restarts OpenCode from here, see
            // `convergeManagedModelCatalog`'s `allowRestart: false` doc.
            void convergeManagedModelCatalog(opencode, cfg, { allowRestart: false }).catch((err) =>
              logger.warn('[refresh] non-blocking catalog reconcile failed', {
                err: err instanceof Error ? err.message : String(err),
              }),
            )
          }
          return {
            // The repo work succeeded either way; `reload.outcome` carries whether
            // the new config actually took. Reporting ok:false here would hide a
            // successful pull behind a reload that safely declined to swap.
            ok: true,
            repo: {
              before: repo.before,
              after: repo.after,
            },
            ...(reload
              ? {
                  reload: {
                    outcome: reload.outcome,
                    ...(reload.outcome === 'swapped'
                      ? {
                          port: reload.port,
                          pid: reload.pid,
                          // Whether the swap interrupted work someone was waiting
                          // on. null = could not tell; never report that as false.
                          turn_ended: reload.turnEnded,
                        }
                      : { reason: reload.reason }),
                  },
                }
              : {}),
            ...(configDir ? { config_dir: configDir } : {}),
            runtime: opencode.getState(),
            runtime_pid: opencode.getPid(),
          }
        },
        // Config releases. The descriptor is
        // always fetched from the API; nothing here takes one as input.
        convergeConfig: (options) =>
          convergeConfigRelease({
            cfg,
            opencode,
            delayBeforeSwapMs: options?.delayBeforeSwapMs,
            // The API reaches a box only through POST /kortix/config/converge,
            // so this is the production convergence path. Without the probe,
            // `mayPromote` is undefined and the last-moment swap cancel never
            // arms — the only turn check left is the API's pre-download read,
            // which is the TOCTOU the cancel exists to close. boot.ts:222
            // supplies the same probe for the boot-scheduled convergence.
            turnInFlight: () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace),
          }),
        // EAGER managed-catalog repair — `POST /kortix/catalog/converge`. The
        // API's turn-start gate calls this AWAITED, and only when the model
        // THIS turn asked for is missing from the box's last-reported map
        // (`missing_managed_model_id` on the request has no bearing on the
        // daemon's own fetch-and-diff; the API decides WHETHER to call this at
        // all, this call decides HOW to repair). One attempt, idle-gated,
        // never ends a running turn — see `convergeManagedModelCatalog`.
        async convergeCatalog() {
          const result = await convergeManagedModelCatalog(opencode, cfg, { allowRestart: true })
          return {
            ok: result.outcome !== 'no-gateway',
            outcome: result.outcome,
            missing: result.missing,
            managed: result.managed,
            reason: result.reason ?? null,
          }
        },
        async abort() {
          const sessionId = readOpenCodeSessionPin()
          if (!sessionId) {
            return { outcome: 'not-pinned', body: { ok: false, error: 'No opencode session pinned.' } }
          }

          const workspace = process.env.KORTIX_WORKSPACE || '/workspace'
          const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(workspace)}`
          noteOpencodeStopRequested(sessionId, 'kortix-abort')
          try {
            // CodeQL js/file-access-to-http (alert 6375) flags `url` here because
            // `sessionId` comes from the pin FILE. Nothing leaves the sandbox:
            // `getInternalUrl()` is the literal `http://127.0.0.1:${port}` built in
            // lifecycle.ts from the daemon's own live port, so the scheme, host and
            // port are never file- or caller-derived. `sessionId` is
            // `encodeURIComponent`-escaped into one path segment and additionally
            // validated on read against /^[A-Za-z0-9_-]{1,128}$/
            // (`isValidOpenCodeSessionId`), so it cannot introduce a host, a scheme
            // or extra path. The only file data on the wire is the session id, sent
            // to loopback. Do not "fix" this by making the host configurable.
            const res = await fetch(url, {
              method: 'POST',
              signal: AbortSignal.timeout(10_000),
            })
            if (!res.ok) {
              const body = (await res.text()).slice(0, 300)
              logger.warn('[abort] opencode abort failed', { sessionId, status: res.status, body })
              return { outcome: 'failed', body: { ok: false, error: `opencode abort failed: ${res.status}`, detail: body } }
            }
            logger.info('[abort] opencode turn aborted', { sessionId })
            return { outcome: 'aborted', body: { ok: true, runtime_session_id: sessionId } }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.warn('[abort] opencode abort threw', { sessionId, error: message })
            return { outcome: 'failed', body: { ok: false, error: message } }
          }
        },
        armAbortAfterTool: ({ runtimeSessionId, ...input }) => quickQueue.arm({ ...input, opencodeSessionId: runtimeSessionId }),
        disarmAbortAfterTool: (promptId) => quickQueue.disarm(promptId),
      }
    },
  }
}
