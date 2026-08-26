import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Outcome of a verified reload.
 *
 * `kept-old` is a SUCCESSFUL outcome of the safety mechanism, not a crash: the
 * new config could not boot, so the running opencode was left alone. Callers
 * must surface it as a failed reload with the reason, never as a plain error —
 * the session is still healthy and the user needs to know their change did not
 * take effect and why.
 */
/**
 * How a config reload was applied, and what it cost.
 *
 * `turnEnded` is only ever true for the respawn path — a dispose re-reads the
 * config in place and interrupts nothing.
 */
export interface ReloadConfigResult {
  how: 'disposed' | 'restarted' | 'kept-old'
  turnEnded: boolean | null
}

export type VerifiedReloadResult =
  | {
      outcome: 'swapped'
      port: number
      pid: number | null
      /**
       * Did the swap stop a turn someone was waiting on?
       *
       * `null` = could not tell (no finalize hook, or opencode never came back
       * in time to ask). Never collapse null to false — "we don't know" and
       * "nothing was interrupted" produce different things said to the user.
       */
      turnEnded: boolean | null
    }
  | { outcome: 'kept-old'; reason: string }
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { access, constants, open, readFile, realpath, stat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

import { AGENT_ENV_SH } from './agent-env-file'
import { LLM_PROXY_PLACEHOLDER_KEY, CONNECTOR_PROXY_PLACEHOLDER_KEY } from './llm-proxy'
import type { Config } from './config'
import { buildGitIdentityEnv } from './git'
import { egressShimEnv } from './egress-shim'
import { logger } from './logger'
import { applyManagedOpencodeEnv } from './managed-opencode-env'
import { mergeProjectEnv, type ProjectEnvStore } from './project-env'
import {
  OPENCODE_CURRENT_LINK,
  OPENCODE_SYSTEM_LINK,
  publishOpencodeNativeLink,
  resolveInstalledOpencodeNative,
} from './opencode-binary'
import {
  SECRET_CAPABILITIES_ENV_NAME,
  writeSecretCapabilitiesInstruction,
} from './secret-capabilities'

const READY_POLL_MS = 100
/** How long the post-respawn turn finalize waits for opencode to answer again.
 *  Generous next to a ~5-12s cold start, and bounded so cleanup cannot outlive
 *  the problem it is cleaning up after. */
const RESPAWN_FINALIZE_TIMEOUT_MS = 60_000
const BOOT_READY_POLL_MS = 50
const READY_TIMEOUT_MS = 20_000
// Once opencode is READY, the readiness probe becomes a slow LIVENESS check.
// Polling /session every READY_POLL_MS (100ms) forever pegged opencode's Bun
// event loop at ~55% of a CPU core PER IDLE SANDBOX (load-tested 2026-06-16) —
// the dominant cap on warm-sandbox density (~14/host). A crash is already caught
// by proc.on('exit'); after ready we only need an occasional liveness ping, so
// drop to a 5s interval (~50x fewer probes → idle opencode falls to ~2% of a core).
const READY_LIVENESS_MS = 5_000
// Liveness hysteresis. A single failed liveness probe used to downgrade
// `ok -> starting`, and proxy.ts then 503s every opencode-bound request
// ("opencode not ready") while state !== 'ok'. A BUSY but healthy opencode
// (mid-heavy-turn) can miss one 2 s `/session` probe and get gated off while
// it is actively serving. So an `ok` session only downgrades after
// READY_LIVENESS_DOWNGRADE_THRESHOLD consecutive failures (a real wedge), and
// re-probes faster (READY_LIVENESS_RECHECK_MS) once a probe starts failing so
// both recovery and a genuine wedge are detected quickly.
const READY_LIVENESS_DOWNGRADE_THRESHOLD = 3
const READY_LIVENESS_RECHECK_MS = 2_000

export const OPENCODE_HOME = homedir()
const OPENCODE_DATA_HOME = `${OPENCODE_HOME}/.local/share`
const OPENCODE_AUTH_PATH = `${OPENCODE_DATA_HOME}/opencode/auth.json`
const CODEX_AUTH_JSON_SECRET = 'CODEX_AUTH_JSON'
const OPENCODE_AUTH_JSON_SECRET = 'OPENCODE_AUTH_JSON'

/**
 * Env values `spawnChild` consumes OUTSIDE the opencode config file.
 *
 * A dispose reload re-reads the config file in place — it never re-runs
 * `spawnChild`, so anything spawn does with the env besides writing that file
 * survives untouched. These two are materialized into
 * `~/.local/share/opencode/auth.json`, so a dispose leaves the OLD subscription
 * credential on disk and opencode keeps authenticating with it.
 *
 * That is a regression the dispose fast path introduced: this path used to be a
 * full restart, which respawned and re-materialized. The symptom is quiet and
 * bad — a user connects a ChatGPT/Codex account, the UI confirms it, and the
 * next turn still runs on the account they replaced.
 *
 */
export const RESPAWN_REQUIRED_ENV_NAMES = [
  CODEX_AUTH_JSON_SECRET,
  OPENCODE_AUTH_JSON_SECRET,
  SECRET_CAPABILITIES_ENV_NAME,
] as const

/**
 * NOT in the list above, deliberately: `KORTIX_CONNECTORS_MCP_ENABLED`.
 *
 * It shapes `out.mcp` INSIDE the config file, and `tryDisposeReload` rewrites
 * that file and makes opencode re-read it — so it belongs to the dispose fast
 * path by the same rule as every other config-file key.
 *
 * Flagged because two comments in this repo disagree and one of them is wrong:
 * `routes/env.ts` says enabling the face "must restart OpenCode because MCP
 * servers are registered only at spawn", which would make dispose insufficient
 * for the email channel's mid-session enable (channels/email/session.ts:123,
 * 208). Whether `POST /global/dispose` re-registers a server that was not
 * previously in the set is UNVERIFIED against the pinned opencode.
 *
 * Left alone rather than guessed at: adding it here breaks the tested
 * invariant in dispose-reload.test.ts ("every name spawnChild consumes outside
 * the config file is listed") and would buy an ~8s respawn for a case nobody
 * has measured. Resolve it with a live sandbox — enable the face mid-session,
 * then ask opencode whether the server is registered — and update whichever
 * comment turns out to be false.
 */

/** Does this env delta need a full respawn rather than a dispose? */
export function requiresRespawn(changedNames: readonly string[]): boolean {
  return changedNames.some((name) =>
    (RESPAWN_REQUIRED_ENV_NAMES as readonly string[]).includes(name),
  )
}

/** True when OpenCode uses the single synthetic `kortix` LLM provider. */
export function hasKortixLlmGateway(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.KORTIX_LLM_PROXY_URL ||
    (env.KORTIX_LLM_BASE_URL && env.KORTIX_TOKEN),
  )
}

/** Convert a gateway wire model into OpenCode's `provider/model` string. */
export function toKortixOpencodeModelRef(ref: string): string {
  const trimmed = ref.trim()
  return trimmed.startsWith('kortix/') ? trimmed : `kortix/${trimmed}`
}

/** Route every configured model through the only provider enabled in gateway mode. */
function normalizeGatewayModelRefs(config: Record<string, unknown>): void {
  for (const key of ['model', 'small_model'] as const) {
    if (typeof config[key] === 'string' && config[key].trim()) {
      config[key] = toKortixOpencodeModelRef(config[key])
    }
  }

  const agents = config.agent
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return
  for (const value of Object.values(agents)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const agent = value as Record<string, unknown>
    if (typeof agent.model === 'string' && agent.model.trim()) {
      agent.model = toKortixOpencodeModelRef(agent.model)
    }
  }
}

/**
 * Native-mode counterpart of {@link normalizeGatewayModelRefs}: a `kortix/…`
 * ref left behind by a gateway→native toggle (compiled agent config, repo
 * config, model prefs) names a provider that does not exist off-gateway.
 * `kortix/<provider>/<model>` unwraps to the native ref; a bare
 * `kortix/<managed-id>` is DELETED so opencode's own default applies instead
 * of every turn dying on ModelNotFound.
 */
function normalizeNativeModelRefs(config: Record<string, unknown>): void {
  const nativize = (ref: string): string | undefined => {
    if (!ref.startsWith('kortix/')) return ref
    const inner = ref.slice('kortix/'.length)
    const slash = inner.indexOf('/')
    if (slash <= 0 || slash === inner.length - 1) return undefined
    return inner
  }
  for (const key of ['model', 'small_model'] as const) {
    if (typeof config[key] === 'string' && config[key].trim()) {
      const next = nativize((config[key] as string).trim())
      if (next === undefined) delete config[key]
      else config[key] = next
    }
  }
  const agents = config.agent
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return
  for (const value of Object.values(agents)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const agent = value as Record<string, unknown>
    if (typeof agent.model === 'string' && agent.model.trim()) {
      const next = nativize(agent.model.trim())
      if (next === undefined) delete agent.model
      else agent.model = next
    }
  }
}

// Assemble the inline opencode config (OPENCODE_CONFIG_CONTENT) the daemon hands
// opencode at spawn. It MERGES over the repo's own opencode config and has four
// independent contributors, any of which may apply:
//   1. the optional Kortix Connector MCP server (KORTIX_CONNECTORS_MCP_ENABLED=1)
//   2. the Kortix LLM gateway provider        (when KORTIX_LLM_* env)
//   3. a Slack permission override            (when this is a Slack session)
//   4. the server-compiled v2 agent config    (KORTIX_COMPILED_AGENT_CONFIG,
//                                               apps/api's compile-agent-config.ts)
// #4 is folded into the BASE (alongside OPENCODE_CONFIG_CONTENT) rather than
// applied as an overlay — it's apps/api's compiled equivalent of "the repo's
// own opencode config" for a v2 project, not a daemon-side session-local
// decision like #1-3.
// If NONE apply there's nothing to inject, so we return undefined and opencode
// just uses the repo config as-is.
export async function buildOpencodeConfigContent(
  env: NodeJS.ProcessEnv,
  opts: {
    injectedSkillsDir?: string | null
    secretCapabilitiesInstructionPath?: string | null
  } = {},
): Promise<string | undefined> {
  const connectorToken = env.KORTIX_TOKEN
  const apiUrl = env.KORTIX_API_URL
  const llmBaseUrl = env.KORTIX_LLM_BASE_URL
  const llmApiKey = env.KORTIX_TOKEN

  // Warm-fork no-restart path (stateful only). When the daemon runs the localhost
  // LLM proxy it exports KORTIX_LLM_PROXY_URL; the provider then points baseURL at
  // the proxy with a placeholder key, making the gateway provider config
  // SESSION-INDEPENDENT (the real per-session token is injected by the proxy, not
  // baked here). This lets a tokenless warm seed bake a usable provider so restore
  // can hot-swap the token with NO opencode restart. Cold/Daytona never set this
  // env → unchanged direct-provider behavior below.
  const llmProxyUrl = env.KORTIX_LLM_PROXY_URL
  const proxyMode = !!llmProxyUrl
  // Optional MCP compatibility face. The agent-facing default is the
  // `kortix connectors` CLI, so we only inject this MCP server when explicitly
  // enabled. In proxy mode its KORTIX_API_URL points at the local connector proxy
  // with a placeholder token; otherwise it receives the real session token.
  const connectorProxyUrl = env.KORTIX_CONNECTORS_PROXY_URL
  const connectorProxyMode = !!connectorProxyUrl
  const connectorMcpEnabled = ['1', 'true', 'yes', 'on'].includes(
    (env.KORTIX_CONNECTORS_MCP_ENABLED ?? '').trim().toLowerCase(),
  )

  // Direct mode needs both token+url; proxy mode needs only the proxy URL.
  const hasConnectorMcp = connectorMcpEnabled && (connectorProxyMode || (!!connectorToken && !!apiUrl))
  const hasLlmGateway = hasKortixLlmGateway(env)
  // A Slack-provisioned session carries SLACK_CHANNEL_ID / SLACK_THREAD_TS (the
  // session identity the API hands us at boot; also what the in-sandbox `slack`
  // CLI uses to post back to the thread). Contributor #3 keys off it.
  const isSlackSession = !!(env.SLACK_THREAD_TS || env.SLACK_CHANNEL_ID)
  // (4) Server-compiled agent config (kortix_version 2 projects only — see
  // apps/api/src/projects/lib/compile-agent-config.ts). apps/api compiles the
  // manifest's `agents:` map into OpenCode's `agent` map + top-level model
  // server-side and hands it down sealed; the daemon only LAYERS its own
  // session-local overlays (MCP/gateway/Slack below) on top, never composes
  // agent behavior itself.
  const compiledAgentConfigRaw = env.KORTIX_COMPILED_AGENT_CONFIG
  const hasCompiledAgentConfig = !!compiledAgentConfigRaw
  // (5) The daemon-injected managed skills dir (`ensureInjectedManagedSkills`).
  // OpenCode loads skills from config-declared `skills.paths` — the overlay dir
  // must be declared or the baked `kortix-*` skills are never discovered on a
  // box with no project config (the platform meta sandbox).
  const injectedSkillsDir =
    opts.injectedSkillsDir && existsSync(opts.injectedSkillsDir) ? opts.injectedSkillsDir : null
  const secretCapabilitiesInstructionPath =
    opts.secretCapabilitiesInstructionPath && existsSync(opts.secretCapabilitiesInstructionPath)
      ? opts.secretCapabilitiesInstructionPath
      : null
  // Native mode (no gateway): the session's model pin still has to reach
  // opencode's config — without an explicit `model`, opencode's default is
  // catalog-order-dependent (Provider.defaultModel walks the models.dev map in
  // file order). `kortix/<a>/<b>` strips to the native ref it wraps (a pin
  // stored while the gateway was on); a bare `kortix/<managed-id>` has no
  // native provider and is ignored.
  const nativeSessionModel = (() => {
    if (hasLlmGateway) return undefined
    const raw = env.KORTIX_OPENCODE_MODEL?.trim()
    if (!raw) return undefined
    const ref = raw.startsWith('kortix/') ? raw.slice('kortix/'.length) : raw
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash === ref.length - 1) return undefined
    return ref
  })()

  // Returning undefined hands the raw OPENCODE_CONFIG_CONTENT straight to
  // opencode — fine, unless native mode must first scrub `kortix/…` refs out
  // of it (a config authored or baked while the gateway was on).
  const nativeScrubNeeded =
    !hasLlmGateway &&
    typeof env.OPENCODE_CONFIG_CONTENT === 'string' &&
    env.OPENCODE_CONFIG_CONTENT.includes('"kortix/')

  // (0) Kortix owns the OpenCode binary: the daemon converges it to the
  // manifest pin (runtime-assets.ts) with `pnpm add -g --allow-build`. OpenCode's
  // own autoupdate (`autoupdate` unset = on) runs whenever a human launches the
  // CLI/TUI in the Session terminal and installs via plain `pnpm add -g`, which
  // skips the postinstall: the launcher becomes a 479-byte stub, the old global
  // dir is deleted and `/opt/kortix/opencode.current` dangles. Essentia
  // 2026-08-22 (session dead, "Still waking this session up") and again
  // 2026-08-25 on two boxes. This contributor ALWAYS applies, so the composed
  // config is never `undefined` any more.
  const KORTIX_MANAGED_OPENCODE_OVERLAY: Record<string, unknown> = { autoupdate: false }

  let base: Record<string, unknown> = {}
  if (hasCompiledAgentConfig) {
    try {
      const parsed = JSON.parse(compiledAgentConfigRaw!)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = { ...base, ...(parsed as Record<string, unknown>) }
      }
    } catch {
      logger.warn('[opencode] KORTIX_COMPILED_AGENT_CONFIG present but not valid JSON; ignoring')
    }
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = { ...base, ...(parsed as Record<string, unknown>) }
      }
    } catch {
    }
  }
  const out: Record<string, unknown> = { ...base }

  if (secretCapabilitiesInstructionPath) {
    const instructions = Array.isArray(out.instructions)
      ? out.instructions.filter((item): item is string => typeof item === 'string')
      : []
    out.instructions = instructions.includes(secretCapabilitiesInstructionPath)
      ? instructions
      : [...instructions, secretCapabilitiesInstructionPath]
  }

  // (5) Injected managed skills — append to whatever `skills.paths` the base
  // config already declares; never clobber.
  if (injectedSkillsDir) {
    const skills =
      out.skills && typeof out.skills === 'object' && !Array.isArray(out.skills)
        ? (out.skills as Record<string, unknown>)
        : {}
    const paths = Array.isArray(skills.paths)
      ? skills.paths.filter((p): p is string => typeof p === 'string')
      : []
    out.skills = {
      ...skills,
      paths: paths.includes(injectedSkillsDir) ? paths : [...paths, injectedSkillsDir],
    }
  }

  // (1) Optional Kortix Connector MCP server. CLI remains the primary agent path.
  if (hasConnectorMcp) {
    const mcp =
      out.mcp && typeof out.mcp === 'object' && !Array.isArray(out.mcp)
        ? (out.mcp as Record<string, unknown>)
        : {}
    out.mcp = {
      ...mcp,
      'kortix-connectors': {
        type: 'local',
        // Use the absolute path so OpenCode's MCP launcher does not depend on
        // PATH propagation. The normal agent path is still `kortix connectors`.
        //
        // `connectors`, plural — it must match a real CLI command. Between
        // 2026-08-06 (e868be1d6c) and this fix it read `connector`, which the
        // CLI router rejects with "unknown command", so OpenCode's launcher
        // got exit 2 and the MCP server never started. The CLI now also
        // accepts the singular as an alias, which recovers snapshots baked
        // with the old string.
        command: ['/usr/local/bin/kortix', 'connectors', 'mcp'],
        enabled: true,
        environment: {
          // Proxy mode: the MCP talks to the localhost connector proxy with a
          // placeholder token; the proxy injects the real per-session token
          // upstream (so the baked config is session-independent → no restart on
          // restore). Direct mode (cold/Daytona): the real token + api url, as before.
          KORTIX_TOKEN: connectorProxyMode ? CONNECTOR_PROXY_PLACEHOLDER_KEY : connectorToken!,
          KORTIX_API_URL: connectorProxyMode ? connectorProxyUrl! : apiUrl!,
          PATH: '/usr/local/bin:/usr/bin:/bin',
          // Lets the CLI target the project-explicit gateway route. Optional —
          // the session token also pins the project for the legacy flat route,
          // so this is belt-and-suspenders. Project id is session-independent so
          // it's safe to bake at seed.
          ...(env.KORTIX_PROJECT_ID ? { KORTIX_PROJECT_ID: env.KORTIX_PROJECT_ID } : {}),
        },
      },
    }
  }

  // (2) Kortix LLM gateway provider.
  if (hasLlmGateway) {
    const provider =
      out.provider && typeof out.provider === 'object' && !Array.isArray(out.provider)
        ? (out.provider as Record<string, unknown>)
        : {}
    // The managed lineup is DEPLOYMENT CONFIG, not image content: a managed
    // model added to the API after this image was built is absent from the
    // baked catalog forever (templates are not rebuilt on a catalog change).
    // On 2026-08-19 that made OpenCode answer `ModelNotFound: kortix/grok-4.6`
    // for two live managed models. So the sandbox LEARNS the managed set from
    // the API it talks to — but NEVER on this path.
    //
    // This read is SYNCHRONOUS and non-blocking by hard rule. Waiting on the
    // in-flight fetch here cost 1.6s of a 6.5s dev boot (config-deps 114ms →
    // runtime-config-ready 1727ms, measured on a Platinum guest 2026-08-19):
    // `opencode serve` cannot bind its port until this config is written, so
    // anything awaited here is dead time on EVERY session boot. Cold boot uses
    // whatever is already known (bundled managed table, or a cache filled by an
    // earlier fetch on this box); a managed model that only the live set knows
    // is picked up by the post-spawn reconcile in main.ts, off the critical
    // path.
    const managedOverlay = cachedManagedModels()
    const kortixProvider = buildKortixProvider({
      // In proxy mode opencode talks to the localhost proxy with a placeholder
      // key; the proxy injects the real per-session token upstream. In direct
      // mode (cold/Daytona) it's the real gateway base + key, as before.
      baseURL: proxyMode ? llmProxyUrl! : llmBaseUrl!,
      apiKey: proxyMode ? LLM_PROXY_PLACEHOLDER_KEY : llmApiKey!,
      managedOverlay,
      // Catalog is org-stable and ships baked into every image at
      // BAKED_LLM_CATALOG_PATH, so this resolves off DISK — no network on the
      // path that gates opencode's port bind. loadGatewayCatalog is local-only
      // by construction now; a missing file degrades to the minimal set and is
      // repaired in the background (scheduleCatalogWarm), never by blocking boot.
      catalogFile: env.KORTIX_LLM_CATALOG_FILE ?? BAKED_LLM_CATALOG_PATH,
    })
    out.provider = {
      ...provider,
      kortix: kortixProvider,
    }
    normalizeGatewayModelRefs(out)
    const resolvedSessionModel = env.KORTIX_OPENCODE_MODEL?.trim()
    const availableGatewayModel = Object.keys(
      (kortixProvider.models as Record<string, unknown> | undefined) ?? {},
    )[0]
    const fallbackModel = resolvedSessionModel || availableGatewayModel
    if (!('model' in out) || typeof out.model !== 'string') {
      if (fallbackModel) out.model = toKortixOpencodeModelRef(fallbackModel)
    }
    if (!('small_model' in out) || typeof out.small_model !== 'string') {
      if (fallbackModel) out.small_model = toKortixOpencodeModelRef(fallbackModel)
    }
    // Gateway mode allowlists providers so leaked provider keys cannot open
    // native Anthropic/OpenAI/GitHub/etc paths that bypass gateway budgets, logs,
    // and BYOK handling. Free models are managed gateway models too, so the
    // selector has one stable catalog before the sandbox has booted.
    out.enabled_providers = ['kortix']
  } else {
    // Native mode: opencode connects providers itself from the API keys in its
    // process env (the project's model-credential secrets, delivered because
    // the gateway is off). Scrub any `kortix/…` refs a gateway→native toggle
    // left in the base config, then layer in the session pin; provider config,
    // catalog, and small_model stay fully opencode-native.
    normalizeNativeModelRefs(out)
    if (nativeSessionModel && (!('model' in out) || typeof out.model !== 'string')) {
      out.model = nativeSessionModel
    }
  }

  // (3) Slack sessions: DENY opencode's blocking `question` tool. A Slack thread
  // is async — there's no live form to answer a synchronous question, so the
  // agent must ask via `slack send` instead; a `question` call would otherwise
  // stall the turn. The web dashboard keeps the tool (it answers `question.asked`
  // natively over opencode's SSE). This is the "make it impossible" half of the
  // fix; the in-box question relay stays as a safety net (and the only path if a
  // project's agent overrides this with its own `"*": "allow"`).
  if (isSlackSession) {
    const permission =
      out.permission && typeof out.permission === 'object' && !Array.isArray(out.permission)
        ? (out.permission as Record<string, unknown>)
        : {}
    out.permission = { ...permission, question: 'deny' }
  }

  Object.assign(out, KORTIX_MANAGED_OPENCODE_OVERLAY)
  return JSON.stringify(out)
}

type KortixProviderOpts = {
  /** baseURL opencode sends LLM requests to (real gateway, or localhost proxy). */
  baseURL: string
  /** apiKey baked into the config (real key, or the proxy placeholder). */
  apiKey: string
  /** Baked catalog file (org-stable models JSON). Local read only — there is
   *  deliberately NO fetch fallback here; see loadGatewayCatalog. */
  catalogFile?: string
  /** Live managed lineup fetched from `${gateway}/models?scope=managed`, or
   *  null when it was unavailable (then the BUNDLED managed set fills gaps). */
  managedOverlay?: Record<string, KortixGatewayModel> | null
}

// The composer's Thinking control lists `Object.keys(model.variants)` and sends
// the pick as `variant` on the prompt; OpenCode resolves that id against THIS
// provider map. On-gateway the web derives the ids from the API's
// `reasoning_options` (packages/sdk provider-selection.ts, via
// @kortix/llm-catalog's generationControlCapabilities), so the provider must
// publish the SAME ids or a picked tier silently does nothing. Mirror of that
// derivation (this package cannot import @kortix/llm-catalog): an `effort`
// knob → its values verbatim; a `budget_tokens` knob → the low/medium/high
// tiers the gateway's Claude mapping accepts; anything else → no variants.
// Each variant carries `reasoningEffort`, which `@ai-sdk/openai-compatible`
// serializes as the `reasoning_effort` the gateway reads. OpenCode keeps an
// explicit config `variants` map verbatim (its own derivation for an
// openai-compatible package would keep only low/medium/high — verified on
// 1.18.21 via /config/providers).
const BUDGET_TOKENS_EFFORT_TIERS = ['low', 'medium', 'high'] as const

export function variantsFromReasoningOptions(
  model: Pick<KortixGatewayModel, 'reasoning_options'>,
): Record<string, Record<string, unknown>> | undefined {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : []
  const effort = options.find((o) => o && o.type === 'effort')
  const ids: string[] = effort?.values?.length
    ? effort.values.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : options.some((o) => o && o.type === 'budget_tokens')
      ? [...BUDGET_TOKENS_EFFORT_TIERS]
      : []
  if (ids.length === 0) return undefined
  return Object.fromEntries(ids.map((id) => [id, { reasoningEffort: id }]))
}

function buildKortixProvider(opts: KortixProviderOpts): Record<string, unknown> {
  const catalog = withModelLimits(withManagedOverlay(loadGatewayCatalog(opts), opts.managedOverlay))
  // Remember the exact id set this config registers. Every spawn writes its
  // config immediately before exec (see spawnOpencode → writeKortixOpencodeConfig),
  // so this is the provider map the RUNNING OpenCode holds — the post-spawn
  // reconcile diffs the live managed set against it to decide whether one
  // controlled restart is warranted.
  lastConfiguredProviderModelIds = new Set(Object.keys(catalog))
  const models = Object.fromEntries(
    Object.entries(catalog).map(([id, model]) => {
      // The gateway catalog's string `provider` is UI metadata describing the
      // upstream family used to group/brand a model. OpenCode 1.1.25+ reserves
      // this key for a nested provider override object, so passing the catalog
      // value through makes the entire config invalid and prevents startup.
      // Preserve every runtime capability while dropping only that UI field.
      const { provider: _catalogProvider, ...opencodeModel } = model
      const variants = opencodeModel.variants ?? variantsFromReasoningOptions(model)
      return [id, variants ? { ...opencodeModel, variants } : opencodeModel]
    }),
  )
  // opencode talks to the Kortix gateway over the OpenAI-compatible wire:
  // POST `${baseURL}/chat/completions`. This is the ONLY transport. The
  // AI-SDK-native `@ai-sdk/gateway` (`/language-model`) path was removed after it
  // returned empty completions on real agentic/image turns while this path
  // stayed reliable.
  const npm = '@ai-sdk/openai-compatible'
  return {
    npm,
    name: 'Kortix',
    options: {
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
    },
    models,
  }
}

// Well-known path the snapshot builder bakes the full org model catalog to (see
// dockerfile-layer.ts `COPY ${catalogPath} /opt/kortix/llm-catalog.json`). Present
// on every modern image; used as the fast, always-available fallback so a slow or
// down gateway never collapses the picker to the ~13-model minimal set.
const BAKED_LLM_CATALOG_PATH = '/opt/kortix/llm-catalog.json'

/** Read + normalize a catalog JSON file ({models:{…}} or a bare id→model map).
 *  Returns null when missing, unreadable, or empty so callers can fall through. */
function readCatalogFile(path: string): Record<string, KortixGatewayModel> | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { models?: Record<string, KortixGatewayModel> } | Record<string, KortixGatewayModel>
    const models = (parsed && typeof parsed === 'object' && 'models' in parsed
      ? (parsed as { models?: Record<string, KortixGatewayModel> }).models
      : (parsed as Record<string, KortixGatewayModel>)) ?? {}
    return Object.keys(models).length > 0 ? models : null
  } catch {
    return null
  }
}

/**
 * Resolve the model catalog for the config opencode boots with — from LOCAL
 * SOURCES ONLY. This function must never touch the network.
 *
 * `opencode serve` cannot bind its port until the config that embeds this
 * catalog is written, so anything awaited here is dead time on every single
 * session boot. The catalog is org-stable and ~400KB, which makes it the worst
 * possible thing to fetch on a hot path: a US sandbox fetching it from the
 * eu-west-2 control plane pays a cross-region round-trip to learn a list that
 * changes on the order of days.
 *
 * So the boot path reads a FILE, always:
 *   1. an EXPLICIT baked file (warm seed's KORTIX_LLM_CATALOG_FILE);
 *   2. the IMAGE-BAKED catalog at the well-known path — staged unconditionally
 *      by build-context.ts and asserted by its completeness guard, so this is
 *      the normal production hit;
 *   3. the minimal hardcoded set (~13 models) as a last resort.
 *
 * Case 3 is a DEGRADED PICKER, not a broken session — every model still routes
 * through the gateway. Recovering the full catalog is handled off the critical
 * path by the caller (see scheduleCatalogWarm), never by blocking boot.
 *
 * The live per-account fetch still exists for the post-adoption refresh
 * (refreshGatewayCatalogFile), which runs when a session is already usable.
 */
function loadGatewayCatalog(opts: KortixProviderOpts): Record<string, KortixGatewayModel> {
  if (opts.catalogFile) {
    const models = readCatalogFile(opts.catalogFile)
    if (models) {
      logger.info(`[opencode] loaded ${Object.keys(models).length} gateway models from baked catalog ${opts.catalogFile}`)
      return models
    }
    logger.warn(`[opencode] baked catalog ${opts.catalogFile} unreadable/empty; falling back`)
  }
  const baked = readCatalogFile(BAKED_LLM_CATALOG_PATH)
  if (baked) {
    logger.info(`[opencode] loaded ${Object.keys(baked).length} models from image-baked catalog ${BAKED_LLM_CATALOG_PATH}`)
    return baked
  }
  // Loud: this means the image was built without its catalog layer, which is a
  // bake regression, not a runtime condition. The session boots fast on the
  // minimal set rather than paying a cross-region fetch to hide it.
  logger.error(
    `[opencode] no catalog file at ${BAKED_LLM_CATALOG_PATH} — booting on the minimal ` +
      `${Object.keys(MINIMAL_FALLBACK_MODELS).length}-model set. This is an IMAGE BAKE defect ` +
      `(build-context.ts stages kortix-llm-catalog.json unconditionally); boot latency is preserved by design.`,
  )
  return MINIMAL_FALLBACK_MODELS
}

/** True when boot had to fall back to the minimal set — i.e. no catalog on disk. */
export function catalogIsDegraded(catalogFile?: string): boolean {
  return !readCatalogFile(catalogFile ?? BAKED_LLM_CATALOG_PATH) && !readCatalogFile(BAKED_LLM_CATALOG_PATH)
}

/**
 * Repair a degraded catalog AFTER boot, off the critical path.
 *
 * Writes the live catalog to the well-known baked path so the next opencode
 * start on this box (a restart, a later session) has the full picker. It
 * deliberately does NOT restart opencode: opencode materializes providers at
 * process start, so adopting a fresh catalog costs a full cold start
 * (4.7-12s measured) — vastly more than a temporarily short model list is worth.
 */
/**
 * Re-validate a fetched catalog into a KNOWN-SHAPE object before it is allowed
 * anywhere near disk.
 *
 * This is not alert-appeasement — the file this guards becomes opencode's config
 * on the next start, and this repo has already been burned by exactly that: an
 * unexpected config field produced ConfigInvalidError and opencode refused to
 * start at all, wedging fresh sessions. A catalog is remote JSON, so treating it
 * as trusted-by-arrival is how a gateway bug or a bad deploy turns into "every
 * new sandbox in this image is dead".
 *
 * So: rebuild the object field-by-field rather than passing it through. Anything
 * unrecognised is dropped, ids and names are bounded, and the result is capped so
 * a pathological response cannot write an unbounded file into the guest.
 * Returns null when nothing survives, which the caller treats as "don't write".
 */
const CATALOG_MAX_MODELS = 20_000
const CATALOG_MAX_ID_LEN = 256
const CATALOG_MAX_NAME_LEN = 512

function sanitizeCatalogForDisk(
  models: Record<string, KortixGatewayModel>,
): Record<string, KortixGatewayModel> | null {
  const out: Record<string, KortixGatewayModel> = {}
  let kept = 0
  for (const [rawId, rawModel] of Object.entries(models)) {
    if (kept >= CATALOG_MAX_MODELS) break
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > CATALOG_MAX_ID_LEN) continue
    if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) continue
    const m = rawModel as Record<string, unknown>
    const name = typeof m.name === 'string' && m.name.length <= CATALOG_MAX_NAME_LEN ? m.name : rawId
    const clean: KortixGatewayModel = { name }
    for (const flag of ['reasoning', 'tool_call', 'attachment', 'temperature', 'structured_output', 'open_weights'] as const) {
      if (typeof m[flag] === 'boolean') (clean as Record<string, unknown>)[flag] = m[flag]
    }
    for (const str of ['provider', 'knowledge', 'family', 'description', 'last_updated'] as const) {
      const v = m[str]
      if (typeof v === 'string' && v.length <= CATALOG_MAX_NAME_LEN) (clean as Record<string, unknown>)[str] = v
    }
    // limit/cost/modalities/reasoning_options are structured; keep them only when
    // they are plain objects, and let withModelLimits/opencode validate depth.
    for (const obj of ['limit', 'cost', 'modalities'] as const) {
      const v = m[obj]
      if (v && typeof v === 'object' && !Array.isArray(v)) (clean as Record<string, unknown>)[obj] = v
    }
    if (Array.isArray(m.reasoning_options)) {
      const opts = m.reasoning_options.filter(
        (o) => o && typeof o === 'object' && !Array.isArray(o) && typeof (o as { type?: unknown }).type === 'string',
      )
      if (opts.length) (clean as Record<string, unknown>).reasoning_options = opts
    }
    out[rawId] = clean
    kept++
  }
  return kept > 0 ? out : null
}

export function scheduleCatalogWarm(fetchBaseURL?: string, fetchApiKey?: string): void {
  scheduleCatalogWarmToPath(fetchBaseURL, fetchApiKey, BAKED_LLM_CATALOG_PATH)
}

/** Test seam: same repair, to a caller-chosen path (the real one is root-owned). */
export function scheduleCatalogWarmToPathForTests(
  fetchBaseURL: string,
  fetchApiKey: string,
  targetPath: string,
): void {
  scheduleCatalogWarmToPath(fetchBaseURL, fetchApiKey, targetPath)
}

function scheduleCatalogWarmToPath(
  fetchBaseURL: string | undefined,
  fetchApiKey: string | undefined,
  targetPath: string,
): void {
  if (!fetchBaseURL || !fetchApiKey) return
  void (async () => {
    try {
      const fetched = await fetchGatewayModels(fetchBaseURL, fetchApiKey)
      if (!fetched) return
      // NEVER write the response through — rebuild it to a known shape first.
      const models = sanitizeCatalogForDisk(fetched)
      if (!models) {
        logger.warn('[opencode] fetched catalog had no usable models after validation; not writing')
        return
      }
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, JSON.stringify({ models }), { mode: 0o644 })
      logger.info(
        `[opencode] repaired degraded catalog off the boot path ` +
          `(${Object.keys(models).length} models kept of ${Object.keys(fetched).length} fetched)`,
      )
    } catch (err) {
      logger.warn('[opencode] background catalog repair failed; minimal set stands', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

export const buildConnectorMcpConfigContent = buildOpencodeConfigContent

/**
 * Where the composed Kortix config is materialized for an OpenCode child.
 * Derived from the DAEMON's own home, never from `env.HOME`: a project may name
 * a secret `HOME` (only `KORTIX_*` names are reserved), and an unwritable value
 * would then fail every session boot instead of one shell command.
 */
const KORTIX_OPENCODE_CONFIG_PATH = join(OPENCODE_HOME, '.config', 'kortix-opencode.json')

/**
 * Materialize the composed Kortix config (see buildOpencodeConfigContent) and
 * return the path OpenCode must read it from, or null when no contributor
 * applies.
 *
 * The config carries the gateway's full model catalog — over a megabyte, far
 * past Linux's 128KB per-env-var ceiling (MAX_ARG_STRLEN). Inlining it via
 * OPENCODE_CONFIG_CONTENT makes execve fail with E2BIG and OpenCode never
 * spawns ("runtime not ready"), so it is always handed over as a FILE.
 */
export async function writeKortixOpencodeConfig(
  env: NodeJS.ProcessEnv,
  opts: {
    configPath?: string
    injectedSkillsDir?: string | null
    secretCapabilitiesInstructionPath?: string | null
  } = {},
): Promise<string | null> {
  const content = await buildOpencodeConfigContent(env, {
    injectedSkillsDir: opts.injectedSkillsDir,
    secretCapabilitiesInstructionPath: opts.secretCapabilitiesInstructionPath,
  })
  if (!content) return null
  const configPath = opts.configPath ?? KORTIX_OPENCODE_CONFIG_PATH
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, content, { mode: 0o600 })
  logger.info(`[opencode] wrote config (${content.length} bytes) to ${configPath}`)
  return configPath
}

const GATEWAY_MODELS_RETRY_DELAYS_MS = [400, 800]
// Per-request hard cap. `opencode serve` cannot bind its port until
// buildOpencodeConfigContent (which awaits this fetch) returns — so a slow/degraded
// gateway `/models` directly blocks session start on BOTH providers (platinum +
// daytona). Bound it and fall back to the minimal catalog rather than hang; a slow
// gateway won't get faster on retry. Restoring the full catalog is the gateway's
// job once /models is fast (it is uncached + ~400KB today).
const GATEWAY_MODELS_TIMEOUT_MS = 2_500
// TOTAL wall-clock ceiling across every attempt + backoff. The per-request cap
// alone does NOT bound this path: responses that are slow but never time out
// (say 2.4s each) still cost attempts × timeout + backoff, which was ~25s of
// dead session-start time on the old 6s × 4 budget. The catalog is a nicety —
// opencode boots fine on the baked/minimal one — so it gets a fixed, small
// slice of the boot budget and nothing more.
const GATEWAY_MODELS_TOTAL_BUDGET_MS = 4_000

async function fetchGatewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, KortixGatewayModel> | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const attempts = GATEWAY_MODELS_RETRY_DELAYS_MS.length + 1
  const deadline = Date.now() + GATEWAY_MODELS_TOTAL_BUDGET_MS
  logger.info(
    `[opencode] fetching gateway models from ${url} ` +
      `(per-try ${GATEWAY_MODELS_TIMEOUT_MS}ms, total budget ${GATEWAY_MODELS_TOTAL_BUDGET_MS}ms)`,
  )
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (Date.now() >= deadline) {
      logger.warn('[opencode] gateway models budget exhausted; falling back to the baked/minimal catalog')
      break
    }
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        // Never let one attempt outlive the total budget.
        signal: AbortSignal.timeout(Math.max(250, Math.min(GATEWAY_MODELS_TIMEOUT_MS, deadline - Date.now()))),
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
      }
      const body = (await res.json()) as { models?: Record<string, KortixGatewayModel> }
      const models = body.models ?? {}
      if (Object.keys(models).length === 0) throw new Error('gateway returned an empty catalog')
      logger.info(`[opencode] fetched ${Object.keys(models).length} gateway models from ${url}`)
      return models
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      logger.warn(
        `[opencode] gateway models fetch ${timedOut ? `timed out (>${GATEWAY_MODELS_TIMEOUT_MS}ms)` : 'failed'} ` +
          `(attempt ${attempt + 1}/${attempts}) ${url}: ${(err as Error).message}`,
      )
      // A slow gateway won't get faster on retry, and opencode is blocked the whole
      // time — fall back immediately on a timeout so the session can start. Only
      // genuine transient failures (5xx / network) are worth retrying.
      if (timedOut) break
      const delay = GATEWAY_MODELS_RETRY_DELAYS_MS[attempt]
      if (delay && Date.now() + delay < deadline) await new Promise((resolve) => setTimeout(resolve, delay))
      else break
    }
  }
  logger.error(`[opencode] gateway models unavailable (${url}); caller will fall back to the baked/minimal catalog`)
  return null
}

// ── Managed-model overlay ────────────────────────────────────────────────────
// The managed lineup (bare-id, provider `kortix` models) is deployment config:
// it changes with LLM_GATEWAY_MANAGED_MODELS / the API's served catalog, NOT
// with the sandbox image. The baked catalog therefore goes stale the moment a
// managed model is added, and OpenCode — which reads provider models once, at
// process start — then answers `ModelNotFound: kortix/<id>` for it (prod
// incident 2026-08-19: grok-4.6, deepseek-v4-pro-0813).
//
// Fix, in two halves that never block each other:
//   1. BOOT reads only what it already knows (cachedManagedModels) — the
//      bundled managed table on a cold box. Zero network, zero wait, because
//      `opencode serve` cannot bind its port until that config is written.
//   2. AFTER the spawn, the prefetch started at proxy-up is settled and diffed
//      against the provider map OpenCode actually booted with. Only a genuinely
//      missing managed id costs one controlled restart (main.ts,
//      reconcileManagedModels). The bundled table ships with every release, so
//      the miss is rare by construction.
// Same principle as the runtime-assets reconcile — the box learns the current
// truth from the API it talks to, without paying for it on the hot path.
const MANAGED_MODELS_TIMEOUT_MS = 2_000
const MANAGED_MODELS_TOTAL_BUDGET_MS = 5_000
const MANAGED_MODELS_ATTEMPTS = 3
// Re-fetch rather than reuse a cache older than this (a warm seed can sit for
// hours between capture and adoption).
const MANAGED_CACHE_TTL_MS = 10 * 60_000

let managedPrefetch: Promise<Record<string, KortixGatewayModel> | null> | null = null
let managedCache: Record<string, KortixGatewayModel> | null = null
let managedCacheAt = 0
/** The kortix-provider model ids the most recently WRITTEN config registers.
 *  Written on every spawn, so it is what the running OpenCode holds. */
let lastConfiguredProviderModelIds: Set<string> | null = null

/**
 * Compose the catalog OpenCode boots with: disk catalog first, managed set on
 * top.
 *
 * - A live managed listing is AUTHORITATIVE for the managed ids it carries
 *   (it comes from the gateway that will resolve them).
 * - With no live listing, the bundled managed set only FILLS ids the disk
 *   catalog lacks — a hand-maintained table never overwrites richer generated
 *   data for a model that is already there.
 *
 * Purely additive in both cases: nothing is removed, so a transient fetch can
 * never shrink a working picker.
 */
export function withManagedOverlay(
  base: Record<string, KortixGatewayModel>,
  live: Record<string, KortixGatewayModel> | null | undefined,
): Record<string, KortixGatewayModel> {
  if (live && Object.keys(live).length > 0) return { ...base, ...live }
  const out = { ...base }
  for (const [id, model] of Object.entries(BUNDLED_MANAGED_MODELS)) {
    if (!out[id]) out[id] = model
  }
  return out
}

/**
 * Fetch the project's SERVABLE set: `GET ${base}/models?scope=picker` (~80KB
 * — managed models the account may use + the providers its secrets connect +
 * routing-named ids, i.e. exactly the list the web picker shows; versus
 * ~3.3MB for the full org catalog, which is why the full fetch gets no place
 * on the boot path). Overlaid on the baked catalog, so a BYOK model added to
 * models.dev after the image was built registers on the `kortix` provider
 * instead of answering `ModelNotFound` (the same failure the managed-only
 * fetch fixed for managed models on 2026-08-19). Returns null on failure or
 * an empty set (a free-tier account with no connected provider legitimately
 * has nothing; callers then keep whatever the disk catalog holds).
 */
export async function fetchManagedModels(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, KortixGatewayModel> | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models?scope=picker`
  const deadline = Date.now() + MANAGED_MODELS_TOTAL_BUDGET_MS
  for (let attempt = 0; attempt < MANAGED_MODELS_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) break
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(
          Math.max(250, Math.min(MANAGED_MODELS_TIMEOUT_MS, deadline - Date.now())),
        ),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { models?: Record<string, KortixGatewayModel> }
      const models = body.models ?? {}
      if (Object.keys(models).length === 0) {
        logger.info(`[opencode] servable listing is empty at ${url}; keeping the on-disk catalog`)
        return null
      }
      // Remote JSON becomes OpenCode's provider config — rebuild it to a known
      // shape before it can get anywhere near the config or the disk.
      const clean = sanitizeCatalogForDisk(models)
      if (!clean) return null
      logger.info(`[opencode] fetched ${Object.keys(clean).length} servable models from ${url}`)
      return clean
    } catch (err) {
      logger.warn(
        `[opencode] managed models fetch failed (attempt ${attempt + 1}/${MANAGED_MODELS_ATTEMPTS}) ` +
          `${url}: ${err instanceof Error ? err.message : String(err)}`,
      )
      if (Date.now() + 200 >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  logger.warn(`[opencode] servable models unavailable (${url}); using the baked catalog + bundled managed set`)
  return null
}

/**
 * Start the managed-lineup fetch as early as the gateway credentials are known
 * (see main.ts, right after the proxy binds). It runs CONCURRENTLY with repo
 * materialization, so by the time the OpenCode config is built the answer is
 * already in hand and the overlay costs ~0ms of boot.
 */
export function startManagedModelsPrefetch(baseUrl?: string, apiKey?: string): void {
  if (!baseUrl || !apiKey) return
  if (managedPrefetch) return
  if (managedCache && Date.now() - managedCacheAt < MANAGED_CACHE_TTL_MS) return
  managedPrefetch = fetchManagedModels(baseUrl, apiKey)
    .then((models) => {
      if (models) rememberManagedModels(models)
      return models
    })
    .catch(() => null)
    .finally(() => {
      managedPrefetch = null
    })
}

/** Publish a freshly fetched managed set so later config rebuilds (an OpenCode
 *  restart, a warm-fork adoption) reuse it without another fetch. */
export function rememberManagedModels(models: Record<string, KortixGatewayModel>): void {
  managedCache = models
  managedCacheAt = Date.now()
}

/**
 * The live managed set IF it is already known — synchronous, never a wait.
 *
 * Returns the cache when it is fresh (an earlier fetch on this box: a prior
 * OpenCode restart, a warm-fork adoption, or the post-spawn reconcile), else
 * null so the caller falls back to the bundled managed table. It deliberately
 * does NOT consult the in-flight prefetch: the config build is what gates
 * OpenCode's port bind, and awaiting the fetch there measured 1.6s of dead
 * boot time on a real dev guest.
 */
export function cachedManagedModels(): Record<string, KortixGatewayModel> | null {
  if (managedCache && Date.now() - managedCacheAt < MANAGED_CACHE_TTL_MS) return managedCache
  return null
}

/**
 * Settle the boot prefetch, for the POST-SPAWN reconcile only.
 *
 * Bounded by the prefetch's own ≤5s budget, which started at proxy-up — by the
 * time OpenCode is spawned it is normally already resolved, so this returns
 * immediately. Never call it from a path that gates the spawn.
 */
export async function settleManagedModelsPrefetch(): Promise<Record<
  string,
  KortixGatewayModel
> | null> {
  const pending = managedPrefetch
  if (pending) await pending.catch(() => null)
  return cachedManagedModels()
}

/** The kortix model ids the running OpenCode's provider map holds (i.e. the ids
 *  in the config written by the last spawn), or null before any config build. */
export function configuredProviderModelIds(): Set<string> | null {
  return lastConfiguredProviderModelIds
}

/**
 * Managed ids the live gateway serves that the running OpenCode does NOT have.
 *
 * Each one is a model the picker offers and the runtime answers `ModelNotFound`
 * for — the 2026-08-19 outage, exactly. An empty result means the boot config
 * was already complete and nothing has to be restarted.
 */
export function missingManagedModelIds(live: Record<string, KortixGatewayModel> | null): string[] {
  if (!live) return []
  const configured = lastConfiguredProviderModelIds
  if (!configured) return []
  return Object.keys(live).filter((id) => !configured.has(id))
}

/**
 * Persist the managed overlay so the NEXT OpenCode start (the reconcile's
 * restart, and any later restart on this box) registers it from disk, not just
 * from this process's cache. Returns the file OpenCode should read, or null
 * when nothing usable could be composed.
 */
export function writeManagedOverlayCatalogFile(opts: {
  currentCatalogFile: string
  targetCatalogFile: string
  managed: Record<string, KortixGatewayModel>
}): string | null {
  const base = readCatalogFile(opts.currentCatalogFile) ?? readCatalogFile(BAKED_LLM_CATALOG_PATH)
  const composed = sanitizeCatalogForDisk(withManagedOverlay(base ?? MINIMAL_FALLBACK_MODELS, opts.managed))
  if (!composed) return null
  mkdirSync(dirname(opts.targetCatalogFile), { recursive: true })
  writeFileSync(opts.targetCatalogFile, JSON.stringify({ models: composed }), { mode: 0o600 })
  return opts.targetCatalogFile
}

/** Test seam: drop prefetch/cache/config state between cases. */
export function resetManagedModelsStateForTests(): void {
  managedPrefetch = null
  managedCache = null
  managedCacheAt = 0
  lastConfiguredProviderModelIds = null
}

export type GatewayCatalogRefreshResult = {
  changed: boolean
  catalogFile: string
}

/**
 * Refresh the catalog inherited from a warm snapshot with the authenticated,
 * project-scoped gateway catalog available after fork adoption.
 *
 * OpenCode materializes provider models at process start. Updating the file is
 * therefore not sufficient by itself: callers must restart OpenCode when
 * `changed` is true. A matching catalog preserves the warm no-restart path.
 */
export async function refreshGatewayCatalogFile(opts: {
  currentCatalogFile: string
  targetCatalogFile: string
  fetchBaseURL: string
  fetchApiKey: string
}): Promise<GatewayCatalogRefreshResult | null> {
  // Both fetches in parallel: the full catalog can fail (it is ~3.3MB and gets
  // a 4s budget) while the ~3KB managed listing still lands — and it is the
  // managed set that decides whether the model a user just picked exists.
  const [liveModels, liveManaged] = await Promise.all([
    fetchGatewayModels(opts.fetchBaseURL, opts.fetchApiKey),
    fetchManagedModels(opts.fetchBaseURL, opts.fetchApiKey),
  ])
  if (liveManaged) rememberManagedModels(liveManaged)

  const currentModels = readCatalogFile(opts.currentCatalogFile)
  const base = liveModels ?? currentModels
  // Nothing live and nothing on disk: leave the caller on the boot catalog.
  if (!base) return null
  // Remote JSON becomes OpenCode's provider config on the next start — rebuild
  // it to a known shape before it reaches the disk (see sanitizeCatalogForDisk).
  const composed = sanitizeCatalogForDisk(withManagedOverlay(base, liveManaged))
  if (!composed) return null
  // `changed` is computed on the COMPOSED result, so a managed model that only
  // the overlay carries still trips the controlled OpenCode restart in the
  // warm-fork adoption path (OpenCode reads provider models at process start).
  // Both sides go through the same normalizer: a raw baked file vs a sanitized
  // rewrite must not read as a change, or every adoption would force a restart.
  const current = currentModels ? sanitizeCatalogForDisk(currentModels) : null
  const changed = !isDeepStrictEqual(current, composed)
  mkdirSync(dirname(opts.targetCatalogFile), { recursive: true })
  writeFileSync(opts.targetCatalogFile, JSON.stringify({ models: composed }), { mode: 0o600 })
  logger.info('[opencode] refreshed authenticated gateway catalog', {
    changed,
    models: Object.keys(composed).length,
    managed: liveManaged ? Object.keys(liveManaged).length : 0,
    fullCatalogLive: !!liveModels,
    target: opts.targetCatalogFile,
  })
  return { changed, catalogFile: opts.targetCatalogFile }
}

// One `reasoning_options` entry (models.dev's shape, mirrored — see
// @kortix/llm-catalog's CatalogReasoningOption). Present iff the model
// exposes a tunable reasoning-effort knob; this is the PRIORITY field the
// chat runtime/composer's effort control reads off the model opencode
// registers, so it must survive the full gateway -> opencode hop intact.
// Three real shapes — `effort` (values), `toggle` (neither), `budget_tokens`
// (min/max, no values — mainline Anthropic's shape) — all fields but `type`
// optional so every shape survives the hop unmodified.
type KortixReasoningOption = { type: string; values?: string[]; min?: number; max?: number }

type KortixCostTier = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tier?: { type: string; size: number }
}

type KortixCost = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tiers?: KortixCostTier[]
  context_over_200k?: KortixCostTier
}

type KortixModalities = { input?: string[]; output?: string[] }

type KortixGatewayModel = {
  name: string
  // The REAL upstream provider this model resolves against ('anthropic',
  // 'openai', 'codex', 'kortix', ...). Every model here is registered under
  // the single synthetic `kortix` opencode provider (see buildKortixProvider
  // below) — this is what the web picker groups/brands by instead of
  // string-splitting the wire model id (see model-selector.tsx's
  // pickerGroupId / use-model-store.ts's subProviderOf).
  provider?: string
  reasoning?: boolean
  reasoning_options?: KortixReasoningOption[]
  // Explicit OpenCode variant map (id → request overlay). Present when the
  // catalog ships one; otherwise derived from `reasoning_options` at config
  // build (see variantsFromReasoningOptions).
  variants?: Record<string, Record<string, unknown>>
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  structured_output?: boolean
  knowledge?: string
  family?: string
  modalities?: KortixModalities
  limit?: { context?: number; input?: number; output?: number }
  cost?: KortixCost
  // Free-text blurb models.dev publishes for the model. Threaded through
  // like the rest of the enriched field set (was previously dropped between
  // the web catalog and the served/fallback gateway shapes).
  description?: string
  open_weights?: boolean
  last_updated?: string
}

export const MINIMAL_FALLBACK_MODELS: Record<string, KortixGatewayModel> = {
  // 2026-08-10 managed slim-down: Claude Opus 4.8 / Claude Sonnet 4.6 / Kimi K3
  // deactivated in @kortix/llm-catalog MANAGED_MODELS — kept commented out here
  // to match, so this fallback map never advertises a model the gateway
  // resolves as model_not_found.
  // 'claude-opus-4.8': {
  //   name: 'Claude Opus 4.8',
  //   provider: 'kortix',
  //   reasoning: true,
  //   tool_call: true,
  //   attachment: true,
  //   temperature: true,
  //   limit: { context: 1_000_000, output: 64_000 },
  // },
  // 'claude-sonnet-4.6': {
  //   name: 'Claude Sonnet 4.6',
  //   provider: 'kortix',
  //   reasoning: true,
  //   tool_call: true,
  //   attachment: true,
  //   temperature: true,
  //   limit: { context: 1_000_000, output: 64_000 },
  // },
  // Managed default for fresh sessions (PLATFORM_DEFAULT_MODEL_ID).
  // Bare id = Kortix-managed.
  'deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    provider: 'kortix',
    reasoning: true,
    tool_call: true,
    attachment: false,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'deepseek-v4-pro-0813': {
    name: 'DeepSeek V4 Pro 0813',
    provider: 'kortix',
    reasoning: true,
    reasoning_options: [
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'high', 'max'] },
    ],
    tool_call: true,
    attachment: false,
    structured_output: false,
    temperature: true,
    limit: { context: 1_048_575, output: 384_000 },
    cost: { input: 1.74, output: 3.48, cache_read: 0.145 },
  },
  'glm-5.2': {
    name: 'GLM 5.2',
    provider: 'kortix',
    reasoning: true,
    tool_call: true,
    attachment: false,
    temperature: true,
    limit: { context: 1_000_000, output: 131_072 },
  },
  'muse-spark-1.2': {
    name: 'Muse Spark 1.2',
    provider: 'kortix',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 131_072 },
  },
  'minimax-m3': {
    name: 'MiniMax M3',
    provider: 'kortix',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 524_288, output: 131_072 },
  },
  // temperature:false — Luna rejects a client-sent temperature (models.dev
  // openrouter/openai/gpt-5.6-luna), same regression class as the OpenAI
  // reasoning-model guard below. Must NOT advertise temperature support or
  // OpenCode sends one and 400s the turn.
  'gpt-5.6-luna': {
    name: 'GPT-5.6 Luna',
    provider: 'kortix',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: false,
    limit: { context: 1_050_000, output: 128_000 },
  },
  'grok-4.6': {
    name: 'Grok 4.6',
    provider: 'kortix',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
    tool_call: true,
    attachment: true,
    structured_output: true,
    temperature: true,
    limit: { context: 500_000, output: 500_000 },
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.5,
      context_over_200k: { input: 4, output: 12, cache_read: 1 },
    },
  },
  // Second Kortix-managed AsterLab model (Kimi K3). Same `kortix` provider
  // branding + `aster` transport (ASTER_API_KEY) as GLM 5.2.
  // `temperature:false` — models.dev advertises Kimi K3 as
  // `temperature:false` (it rejects a client-sent temperature), matching
  // capabilitiesOf() in the served catalog. Must NOT advertise temperature
  // support or OpenCode sends one and 400s the turn.
  // 'kimi-k3': {
  //   name: 'Kimi K3',
  //   provider: 'kortix',
  //   reasoning: true,
  //   tool_call: true,
  //   attachment: true,
  //   temperature: false,
  //   limit: { context: 1_048_576, output: 131_072 },
  // },
  'openai/gpt-5.5': {
    name: 'GPT-5.5',
    provider: 'openai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    // models.dev: false — OpenAI reasoning models (gpt-5.x) reject a
    // client-sent `temperature`, so advertising support here would make
    // OpenCode send one and 400 the turn whenever this fallback catalog is
    // in effect. Must match capabilitiesOf() in the served catalog
    // (apps/api/src/llm-gateway/models/catalog-models.ts).
    temperature: false,
    limit: { context: 1_050_000, output: 64_000 },
  },
  'google/gemini-3.5-flash': {
    name: 'Gemini 3.5 Flash',
    provider: 'google',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'google/gemini-3.1-pro-preview': {
    name: 'Gemini 3.1 Pro',
    provider: 'google',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'deepseek/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'deepseek/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'minimax/minimax-m3': {
    name: 'MiniMax M3',
    provider: 'minimax',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'moonshotai/kimi-k2.6': {
    name: 'Kimi K2.6',
    provider: 'moonshotai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 262_144, output: 64_000 },
  },
  'z-ai/glm-5.1': {
    name: 'GLM 5.1',
    provider: 'z-ai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 202_752, output: 64_000 },
  },
  'x-ai/grok-4.3': {
    name: 'Grok 4.3',
    // models.dev's real provider id is 'xai' (no hyphen) — matches
    // @kortix/llm-catalog's PROVIDER_LABELS key and gatewayModelsAll's
    // `provider` field. The model-id PREFIX here ('x-ai/...') is just this
    // fallback table's own key convention and is left alone; only the
    // `provider` value (what the picker actually groups/labels by) must
    // match models.dev's real id or the picker mislabels/falls back to
    // "Kortix" for this entry.
    provider: 'xai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
}

/** The managed subset of the bundled fallback table: bare ids branded `kortix`.
 *  Used when the live managed fetch is unavailable, so a managed model is
 *  present in OpenCode's provider map even with a stale baked catalog AND a
 *  down gateway. Kept in sync with @kortix/llm-catalog MANAGED_MODELS by
 *  __tests__/managed-fallback-sync.test.ts — a managed model missing here and
 *  missing from the baked image is the exact 2026-08-19 ModelNotFound outage. */
export const BUNDLED_MANAGED_MODELS: Record<string, KortixGatewayModel> = Object.fromEntries(
  Object.entries(MINIMAL_FALLBACK_MODELS).filter(
    ([id, model]) => !id.includes('/') && model.provider === 'kortix',
  ),
)

// Conservative window for a model we have no declared limit for. Better to
// compact a little early than to never compact and get stuck at the wall.
const DEFAULT_MODEL_LIMIT = { context: 200_000, output: 32_000 } as const

// Known limits indexed by bare model id (the tail after the last "/"), so a
// catalog model offered under any provider prefix (e.g.
// "alibaba-cn/deepseek-v4-flash") still resolves to the right window.
const KNOWN_LIMIT_BY_TAIL: Record<string, { context?: number; output?: number }> = (() => {
  const out: Record<string, { context?: number; output?: number }> = {}
  for (const [id, model] of Object.entries(MINIMAL_FALLBACK_MODELS)) {
    if (!model.limit) continue
    out[id.split('/').pop() ?? id] = model.limit
  }
  return out
})()

// Guarantee every model carries a context window. The gateway /models endpoint
// returns NO per-model limits, so without this OpenCode sees models with no
// context limit, can't size the conversation, and auto-compaction never fires —
// long sessions then blow past the window and get stuck (session pinned at 100%
// context). Backfill from the known-model table (exact id, then bare id), else a
// conservative default. Models that already declare a usable limit are untouched.
export function withModelLimits(
  models: Record<string, KortixGatewayModel>,
): Record<string, KortixGatewayModel> {
  const out: Record<string, KortixGatewayModel> = {}
  for (const [id, model] of Object.entries(models)) {
    if (typeof model.limit?.context === 'number' && model.limit.context > 0) {
      out[id] = model
      continue
    }
    const known = MINIMAL_FALLBACK_MODELS[id]?.limit ?? KNOWN_LIMIT_BY_TAIL[id.split('/').pop() ?? id]
    out[id] = { ...model, limit: known ?? { ...DEFAULT_MODEL_LIMIT } }
  }
  return out
}

function materializeOpencodeAuth(env: NodeJS.ProcessEnv) {
  const authJson = env[CODEX_AUTH_JSON_SECRET] ?? env[OPENCODE_AUTH_JSON_SECRET]
  delete env[CODEX_AUTH_JSON_SECRET]
  delete env[OPENCODE_AUTH_JSON_SECRET]
  if (!authJson?.trim()) return

  try {
    const parsed = JSON.parse(authJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('auth json must be an object')
    }

    mkdirSync(dirname(OPENCODE_AUTH_PATH), { recursive: true })
    writeFileSync(OPENCODE_AUTH_PATH, JSON.stringify(parsed, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(OPENCODE_AUTH_PATH, 0o600)
    logger.info('[opencode] materialized project-scoped Codex auth.json')
  } catch (err) {
    logger.warn('[opencode] ignored invalid Codex/OpenCode auth project secret', {
      err: (err as Error).message,
    })
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${bin}`])
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('close', (code) => resolve(code === 0 ? out.trim() || null : null))
    child.on('error', () => resolve(null))
  })
}

export interface OpencodeBinaryDetectionOptions {
  nativeBinaryFastPathEnabled?: boolean
  currentLink?: string
  systemLink?: string
  isExecutable?: (path: string) => Promise<boolean>
  resolveInstalledNative?: () => Promise<string>
  publishNativeLink?: (nativePath: string, linkPath: string) => Promise<void>
  findOnPath?: (bin: string) => Promise<string | null>
  isStubLauncher?: (path: string) => Promise<boolean>
}

/**
 * True when `launcherPath` is — or is a pnpm shim for — the tiny shell stub pnpm
 * leaves in place of a native OpenCode when the package's postinstall did not
 * run. The real launcher is a >100 MB executable; pnpm's shim is a short shell
 * script that `exec`s it and names it in a trailing `# cmd-shim-target=` line.
 * Conservative by construction: anything this cannot read or resolve is NOT a
 * stub, so a false positive can never take a working launcher away.
 */
export async function isStubOpencodeLauncher(launcherPath: string): Promise<boolean> {
  try {
    const target = await realpath(launcherPath)
    const info = await stat(target)
    if (info.size > 64 * 1024) return false
    const text = await readFile(target, 'utf8')
    if (/postinstall script was not run/i.test(text)) return true
    // pnpm's cmd-shim: follow one hop to the package's own launcher.
    const shimTarget =
      text.match(/^#\s*cmd-shim-target=(.+)$/m)?.[1]?.trim() ??
      text.match(/"?([^"\s]+opencode-ai\/bin\/opencode(?:\.exe)?)"?/)?.[1]
    if (!shimTarget) return false
    const resolved = shimTarget.replace(/^\$basedir/, dirname(target))
    const binInfo = await stat(resolved).catch(() => null)
    if (!binInfo || binInfo.size > 64 * 1024) return false
    return /postinstall script was not run/i.test(await readFile(resolved, 'utf8'))
  } catch {
    return false
  }
}

export async function detectOpencodeBinary(
  options: OpencodeBinaryDetectionOptions = {},
): Promise<string | null> {
  const currentLink = options.currentLink ?? OPENCODE_CURRENT_LINK
  const systemLink = options.systemLink ?? OPENCODE_SYSTEM_LINK
  const checkExecutable = options.isExecutable ?? isExecutable
  const findOnPath = options.findOnPath ?? which

  // The one cold-boot experiment switch must restore the pre-optimization
  // launch path completely. Disabled sessions use pnpm's PATH launcher and do
  // not discover or publish native-binary links. Existing stable links remain
  // an availability fallback only when that verified launcher disappeared.
  if (!options.nativeBinaryFastPathEnabled) {
    const pathLauncher = await findOnPath('opencode')
    // A pnpm launcher that resolves to the postinstall-less stub OpenCode's own
    // autoupdate leaves behind (479 bytes: "opencode-ai's postinstall script was
    // not run") exits at once; spawning it puts the daemon in a respawn loop
    // with "binary not found" and the session never wakes (Essentia
    // 2026-08-22, re-armed 2026-08-25). Never launch it; fall through to the
    // managed links, which the convergence pass repairs.
    if (pathLauncher && !(await (options.isStubLauncher ?? isStubOpencodeLauncher)(pathLauncher))) {
      return pathLauncher
    }
    if (await checkExecutable(currentLink)) return currentLink
    if (await checkExecutable(systemLink)) return systemLink
    return null
  }

  if (await checkExecutable(currentLink)) return currentLink
  if (await checkExecutable(systemLink)) return systemLink

  const resolveInstalledNative = options.resolveInstalledNative ?? resolveInstalledOpencodeNative
  const publishNativeLink =
    options.publishNativeLink ??
    ((nativePath: string, linkPath: string) => publishOpencodeNativeLink(nativePath, linkPath))
  try {
    const nativePath = await resolveInstalledNative()
    await publishNativeLink(nativePath, currentLink)
    return currentLink
  } catch (err) {
    logger.warn('[opencode] native binary discovery failed; using PATH launcher', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return await findOnPath('opencode')
}

const EXECUTABLE_PREFETCH_BUFFER_BYTES = 4 * 1024 * 1024

export async function prefetchExecutablePages(
  path: string,
  signal?: AbortSignal,
  allocateBuffer: (size: number) => Buffer = (size) => Buffer.allocUnsafe(size),
): Promise<number> {
  if (signal?.aborted) throw signal.reason
  const buffer = allocateBuffer(EXECUTABLE_PREFETCH_BUFFER_BYTES)
  const handle = await open(path, 'r', 0o600)
  let bytes = 0
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const result = await handle.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
    }
  } finally {
    await handle.close()
  }
  return bytes
}

async function resolveOpencodeCwd(cfg: Config): Promise<string> {
  try {
    const project = await stat(cfg.projectTarget)
    if (project.isDirectory()) return cfg.projectTarget
  } catch {}
  return cfg.workspace
}

export type OpencodeState = 'starting' | 'ok' | 'down'

export interface LivenessDecisionInput {
  /** The supervisor's current opencode state. */
  state: OpencodeState
  /** Did THIS liveness probe get a healthy answer from opencode? */
  ready: boolean
  /** Consecutive failed liveness probes so far (only meaningful while `ok`). */
  consecutiveFailures: number
  /** Downgrade `ok -> starting` only on the Nth consecutive failure. */
  threshold: number
}

export interface LivenessDecision {
  state: OpencodeState
  consecutiveFailures: number
  /** True on the transition that actually gated opencode off — for logging. */
  downgraded: boolean
}

/**
 * Decide the next opencode state from one liveness-probe result, with
 * hysteresis. Pure + deterministic — see opencode-liveness-hysteresis.test.ts.
 *
 * - a ready probe is always `ok` and clears the failure count;
 * - an `ok` session TOLERATES failures below `threshold` (stays `ok`), and
 *   downgrades to `starting` only on the Nth consecutive failure;
 * - any other non-ready state resolves to `starting` (unchanged from the
 *   pre-hysteresis behaviour), with the counter reset.
 */
export function nextLivenessState(input: LivenessDecisionInput): LivenessDecision {
  if (input.ready) return { state: 'ok', consecutiveFailures: 0, downgraded: false }
  if (input.state === 'ok') {
    const consecutiveFailures = input.consecutiveFailures + 1
    if (consecutiveFailures >= input.threshold) {
      return { state: 'starting', consecutiveFailures, downgraded: true }
    }
    return { state: 'ok', consecutiveFailures, downgraded: false }
  }
  return { state: 'starting', consecutiveFailures: 0, downgraded: false }
}

export type Opencode = {
  prefetchBinary(): Promise<boolean>
  cancelBinaryPrefetch(): void
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  reloadConfig(opts?: { mustRespawn?: boolean }): Promise<ReloadConfigResult>
  /**
   * Boot the new opencode, verify it serves, then swap and retire the old one.
   * Never leaves the session without an opencode.
   */
  /**
   * @param opts.forceFail Fault injection — treat the candidate as failed to
   * boot even though it started. The only way to exercise the decline path on
   * a real box: the API validates agent configs against opencode's schema
   * before they ever reach a sandbox, so no supported input can produce a
   * config that fails to start.
   */
  reloadVerified(opts?: { forceFail?: boolean }): Promise<VerifiedReloadResult>
  reconfigure(nextCfg: Config, nextOpencodeConfigDir: string, nextProjectEnv?: ProjectEnvStore): void
  getPid(): number | null
  getInternalUrl(): string
  /**
   * The port opencode is listening on RIGHT NOW.
   *
   * It moves: a verified reload boots the replacement on the idle half of the
   * port pair and promotes it, so the live port alternates. Anything outside
   * this process that needs to reach opencode directly — the API's PTY
   * WebSocket proxy is the live case, since the daemon cannot carry a WS — has
   * to ask rather than assume 4096.
   */
  getActivePort(): number
  getBinaryPath(): string | null
  getState(): OpencodeState
  markReady(): void
  /** Resolves when the active supervised process answers the real session API. */
  waitForCurrentReadyResponse(): Promise<void>
}

export interface OpencodeSupervisorOptions {
  onStartupMark?: (label: string) => void
  onFirstReadyResponse?: () => void
  binaryPathOverride?: string
  binaryPathResolverOverride?: () => Promise<string | null>
  nativeBinaryFastPathEnabled?: boolean
  prefetchExecutableOverride?: (path: string, signal: AbortSignal) => Promise<number>
  configPathOverride?: string
  /**
   * opencode died without anyone asking it to, and has just been respawned.
   *
   * A turn ends only when opencode emits `session.idle`/`session.error` over
   * SSE. A killed process emits neither, so an in-flight turn is left with a
   * part stuck "running" and the client streams it forever — the 57s spinner
   * you get when an agent runs `kill <opencode pid>` from its own shell, and
   * equally what an OOM or a crash produces.
   *
   * The supervisor cannot fix that itself: it knows nothing about sessions.
   * It reports the fact and main.ts finalizes the orphaned turn, the same way
   * boot already does when it adopts a root whose last turn never completed.
   */
  /**
   * Runs once opencode is serving again after it was replaced.
   *
   * Resolves TRUE when it actually aborted an incomplete turn — i.e. the
   * replacement really did stop work someone was waiting on. That is the only
   * honest basis for telling a user "your turn was stopped, continue": a
   * pre-flight "is a turn running?" check races the turn finishing on its own,
   * and would say it to people whose work completed normally.
   */
  onUnplannedRespawn?: () => void | Promise<boolean | void>
}

export function createOpencodeSupervisor(
  cfg: Config,
  opencodeConfigDir: string,
  projectEnv?: ProjectEnvStore,
  options: OpencodeSupervisorOptions = {},
): Opencode {
  let currentCfg = cfg
  let currentOpencodeConfigDir = opencodeConfigDir
  let currentProjectEnv = projectEnv
  let child: ChildProcess | null = null
  let activePort = cfg.opencodeInternalPort
  // The port each spawned opencode was told to serve on. THIS is the truth
  // about where the live process listens; `activePort` is only the plan for the
  // next spawn. Every reader of the live port goes through livePort(), so the
  // two can never disagree the way they did on Essentia 2026-08-25 (daemon
  // `starting` on 4096 for two hours while its own child served on 4097).
  const childPorts = new WeakMap<ChildProcess, number>()
  function livePort(): number {
    return (child ? childPorts.get(child) : undefined) ?? activePort
  }
  let binaryPath: string | null = null
  let stopping = false
  let restartDelayMs = 500
  let state: OpencodeState = 'starting'
  /** Consecutive failed liveness probes while `ok` (see nextLivenessState). */
  let livenessFailures = 0
  let readinessTimer: ReturnType<typeof setTimeout> | null = null
  let firstReadyResponseReported = false
  let readyResponseProcess: ChildProcess | null = null
  const readyResponseWaiters = new Set<() => void>()
  let opencodeCwd = cfg.workspace
  const startupMark = options.onStartupMark ?? (() => {})
  let binaryResolutionPromise: Promise<string | null> | null = null
  let binaryPrefetchPromise: Promise<boolean> | null = null
  let binaryPrefetchController: AbortController | null = null

  async function resolveBinaryPath(): Promise<string | null> {
    if (!binaryResolutionPromise) {
      binaryResolutionPromise = options.binaryPathOverride
        ? Promise.resolve(options.binaryPathOverride)
        : (options.binaryPathResolverOverride?.() ??
          detectOpencodeBinary({
            nativeBinaryFastPathEnabled: options.nativeBinaryFastPathEnabled === true,
          }))
    }
    let resolved: string | null
    try {
      resolved = await binaryResolutionPromise
    } catch (err) {
      binaryResolutionPromise = null
      throw err
    }
    if (!resolved) binaryResolutionPromise = null
    if (resolved && binaryPath !== resolved) {
      binaryPath = resolved
      startupMark('runtime-binary-resolved')
    }
    return resolved
  }

  async function prefetchBinaryOnce(signal: AbortSignal): Promise<boolean> {
    const startedAt = Date.now()
    let bin: string | null = null
    try {
      bin = await resolveBinaryPath()
      if (!bin) throw new Error('OpenCode binary not found')
      startupMark('runtime-binary-prefetch-started')
      const prefetch = options.prefetchExecutableOverride ?? prefetchExecutablePages
      const bytes = await prefetch(bin, signal)
      if (signal.aborted) throw signal.reason
      startupMark('runtime-binary-prefetched')
      logger.info('[opencode] executable pages prefetched', {
        binaryPath: bin,
        bytes,
        durationMs: Date.now() - startedAt,
      })
      return true
    } catch (err) {
      if (signal.aborted) {
        startupMark('runtime-binary-prefetch-cancelled')
        logger.info('[opencode] executable prefetch stopped before spawn', {
          binaryPath: bin,
          durationMs: Date.now() - startedAt,
        })
      } else {
        startupMark('runtime-binary-prefetch-failed')
        logger.warn('[opencode] executable prefetch failed; using normal demand paging', {
          binaryPath: bin,
          err: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        })
      }
      return false
    }
  }

  function ensureCwdExists(): string {
    try {
      mkdirSync(opencodeCwd, { recursive: true })
      return opencodeCwd
    } catch (err) {
      logger.warn('[opencode] could not mkdir cwd, falling back to /', { opencodeCwd, err: (err as Error).message })
      return '/'
    }
  }

  function sweepBunExtractions() {
    const tmp = process.env.TMPDIR || '/tmp'
    try {
      for (const name of readdirSync(tmp)) {
        if (name.endsWith('-00000000.so')) {
          try { unlinkSync(join(tmp, name)) } catch {}
        }
      }
    } catch {}
  }

  /**
   * Spawn an opencode.
   *
   * `port` defaults to the live half of the port pair and `supervise` to true —
   * that is the ordinary child, the one `child` points at and the one whose
   * exit triggers an automatic respawn.
   *
   * A verified reload passes the STANDBY port and `supervise: false` to boot a
   * candidate alongside the running one. An unsupervised candidate must not
   * touch `child`, must not flip `state`, and must not schedule a respawn when
   * it exits: it is on trial, and a candidate that dies is a verdict, not an
   * outage.
   */
  async function spawnChild(
    bin: string,
    opts: { port?: number; supervise?: boolean } = {},
  ): Promise<ChildProcess> {
    const port = opts.port ?? livePort()
    const supervise = opts.supervise !== false
    sweepBunExtractions()
    try {
      mkdirSync(OPENCODE_HOME, { recursive: true })
    } catch (err) {
      logger.warn('[opencode] could not create home dir; falling back to inherited HOME', {
        opencodeHome: OPENCODE_HOME,
        err: (err as Error).message,
      })
    }
    const baseEnv = currentProjectEnv ? mergeProjectEnv(process.env, currentProjectEnv) : process.env
    let env: NodeJS.ProcessEnv = applyManagedOpencodeEnv({
      ...baseEnv,
      ...buildGitIdentityEnv(currentCfg),
      OPENCODE_CONFIG_DIR: currentOpencodeConfigDir,
      // Every non-interactive shell opencode spawns (`bash -c`) sources this,
      // so live project secrets reach the agent's commands without any
      // opencode plugin/config. Interactive shells + terminals get it from the
      // image-baked /etc/profile.d + /etc/bash.bashrc hooks instead.
      BASH_ENV: AGENT_ENV_SH,
      // Egress shim, when one is running. The agent's SHELLS get these from
      // AGENT_ENV_SH above; setting them on the opencode process too covers its
      // in-process HTTP clients (the built-in webfetch tool), which never go
      // through a shell. Safe for model traffic: NO_PROXY carries 127.0.0.1 (the
      // local LLM proxy) and the Kortix API host.
      ...egressShimEnv(),
      PORT: undefined,
      APP_PORT: undefined,
    })
    materializeOpencodeAuth(env)

    // Boot profiling: when KORTIX_OPENCODE_DEBUG=1, ask opencode to emit its own
    // verbose startup logs (interleaved into the daemon log via inherited
    // stdio) so a real cold boot reveals where the spawn→ready window goes.
    // Opt-in only — no log noise in normal operation.
    if (process.env.KORTIX_OPENCODE_DEBUG === '1') {
      env.OPENCODE_LOG_LEVEL = 'DEBUG'
    }
    // The standalone binary already embeds a models.dev snapshot, and Kortix
    // injects its managed provider catalog below. A remote catalog refresh adds
    // network contention without adding a model that this session can use.
    if (process.env.KORTIX_COMPILED_RUNTIME_FORMAT === 'kortix.compiled-runtime.v1') {
      env.OPENCODE_DISABLE_MODELS_FETCH = '1'
    }

    let secretCapabilitiesInstructionPath: string | null = null
    try {
      secretCapabilitiesInstructionPath = writeSecretCapabilitiesInstruction(baseEnv)
    } catch (err) {
      logger.warn('[opencode] secret capability instruction file unavailable; env catalog remains available', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    const configPath = await writeKortixOpencodeConfig(baseEnv, {
      configPath: options.configPathOverride,
      injectedSkillsDir: join(currentOpencodeConfigDir, 'skills'),
      secretCapabilitiesInstructionPath,
    })
    if (configPath) {
      env.OPENCODE_CONFIG = configPath
      delete env.OPENCODE_CONFIG_CONTENT
    }
    startupMark('runtime-config-ready')

    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1']

    const cwd = ensureCwdExists()
    logger.info('[opencode] spawning', { bin, port, cwd, supervise })
    // detached: true makes opencode the leader of its own process group, so
    // stop()/restart() can SIGTERM/SIGKILL the whole group (-pid) instead of
    // just this direct child. Without it, a grandchild opencode forks itself
    // (e.g. its internal `bun install` for the config dir's tool deps) can
    // outlive a restart-triggered kill and keep writing into a directory a
    // freshly-spawned opencode is installing into concurrently — a real path
    // to a torn/corrupted node_modules that then fails every session's first
    // prompt until the sandbox is rebuilt.
    const proc = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    })
    childPorts.set(proc, port)
    proc.on('error', (err) => {
      logger.error('[opencode] spawn error', err)
    })

    if (supervise) {
      readyResponseProcess = null
      child = proc
      superviseChild(proc)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', () => {
          startupMark('runtime-process-spawned')
          resolve()
        })
        proc.once('error', reject)
      })
    } catch (err) {
      // Node does not guarantee an `exit` event after an asynchronous spawn
      // error. Detach the failed generation here and reject into the caller's
      // existing retry path. This also makes candidate verification fail fast.
      if (supervise && child === proc) {
        readyResponseProcess = null
        child = null
        state = stopping ? 'down' : 'starting'
      }
      throw err
    }
    return proc
  }

  /**
   * Wire the auto-respawn contract onto a child.
   *
   * Split out of spawnChild so a promoted candidate gets exactly the same
   * supervision the ordinary child has — a candidate promoted without this
   * would die silently and never come back.
   */
  function superviseChild(proc: ChildProcess) {
    proc.on('exit', (code, signal) => {
      logger.warn('[opencode] child exited', { code, signal })
      if (child !== proc) {
        logger.info('[opencode] retired child exit ignored', { pid: proc.pid })
        return
      }
      if (readyResponseProcess === proc) readyResponseProcess = null
      child = null
      state = stopping ? 'down' : 'starting'
      if (stopping) return
      scheduleUnplannedRespawn()
    })
  }

  /**
   * Signal a process GROUP and resolve once it is gone (or the hard-kill
   * deadline passes). Extracted from stop() so the verified reload can retire
   * the old opencode with the same discipline.
   */
  function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    const killGroup = (sig: NodeJS.Signals) => {
      if (proc.pid) {
        try {
          process.kill(-proc.pid, sig)
          return
        } catch {}
      }
      proc.kill(sig)
    }
    return new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', () => resolve())
      try {
        killGroup(signal)
      } catch {
        return resolve()
      }
      setTimeout(() => {
        try {
          killGroup('SIGKILL')
        } catch {}
        resolve()
      }, 5_000).unref()
    })
  }

  function markReady() {
    if (state !== 'ok') logger.info('[opencode] ready')
    state = 'ok'
    restartDelayMs = 500
  }

  function reportReadyResponse(proc: ChildProcess) {
    if (stopping || child !== proc) return
    readyResponseProcess = proc
    for (const resolve of readyResponseWaiters) resolve()
    readyResponseWaiters.clear()
    if (!firstReadyResponseReported) {
      firstReadyResponseReported = true
      options.onFirstReadyResponse?.()
    }
  }

  /**
   * Bring opencode back after it died on its own, and finalize the turn it took
   * with it.
   *
   * Reschedules ITSELF on a failed spawn. `spawnChild` writes the config before
   * spawning, so a full or read-only disk rejects before any process exists —
   * and with no process there is no `exit` event, so relying on that to retry
   * would leave opencode down permanently once the first attempt failed. The
   * backoff is shared with the exit path, so a persistent failure backs off to
   * 30s rather than spinning.
   */
  function scheduleUnplannedRespawn(): void {
    if (stopping) return
    const delay = restartDelayMs
    restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
    logger.info('[opencode] restarting', { delayMs: delay })
    setTimeout(() => {
      if (stopping || !binaryPath) return
      void spawnChild(binaryPath)
        .then(() => {
          if (!options.onUnplannedRespawn) return
          // `spawnChild` resolving means the PROCESS started, not that opencode
          // is listening — its HTTP server comes up seconds later. Firing the
          // hook here would have it call `/message` against a dead port, read
          // the failure as "no turn to finalize", and silently do nothing in
          // exactly the case it exists for. Wait for the readiness probe.
          return waitUntilReady(RESPAWN_FINALIZE_TIMEOUT_MS).then((ready) => {
            if (!ready) {
              logger.warn('[opencode] respawned but never became ready; orphaned turn left as-is')
              return
            }
            try {
              options.onUnplannedRespawn?.()
            } catch (err) {
              logger.warn('[opencode] unplanned-respawn hook threw', {
                err: (err as Error).message,
              })
            }
          })
        })
        .catch((err) => {
          logger.error('[opencode] respawn failed; retrying', { err: (err as Error).message })
          scheduleUnplannedRespawn()
        })
    }, delay)
  }

  /** How long a candidate opencode gets to start serving before we give up. */
  const VERIFY_READY_TIMEOUT_MS = 90_000

  /**
   * Reload the config by BOOTING THE NEW OPENCODE FIRST.
   *
   * The old path was `stop()` then `start()`: kill the only opencode, then hope
   * the replacement comes up. When it did not — a config the new build rejects,
   * a bad agent file, a dependency install that fails — the session was left
   * with no opencode at all, and the reload had destroyed the very thing it was
   * supposed to update.
   *
   * So: spawn the candidate on the idle port, prove it actually serves the
   * session API, promote that exact process, and only then retire the old one.
   * If it never comes up, the old opencode remains active.
   *
   * The swap is a port trade, not a port allocation. Both halves are fixed at
   * startup and both are blocked in the web proxy's self-port set; picking an
   * ephemeral port would leave the live one unguarded (see config.ts).
   *
   * Existing streams end when the old process retires. New requests route to
   * the promoted process before retirement starts.
   */
  /**
   * Prove the new config actually BOOTS, without touching the running opencode.
   *
   * Spawns a candidate on the idle port while the live one keeps serving and
   * waits for the real session API. A successful result owns a live process;
   * the caller must either promote it or retire it.
   */
  async function verifyCandidateBoots(
    opts: { forceFail?: boolean } = {},
  ): Promise<
    | { ok: true; candidate: ChildProcess; port: number }
    | { ok: false; reason: string }
  > {
    if (!binaryPath) return { ok: false, reason: 'opencode binary not resolved yet' }
    if (stopping) return { ok: false, reason: 'supervisor is shutting down' }

    const candidatePort = livePort() === currentCfg.opencodeInternalPort
      ? currentCfg.opencodeStandbyPort
      : currentCfg.opencodeInternalPort
    // The idle half must be idle. `opencode serve --port <busy>` exits at once
    // with ServeError (verified on 1.18.23), but `probeUntilReady` asks the
    // PORT, not the process: whatever already answers there — the incumbent,
    // if `activePort` has drifted from where opencode really listens — would
    // "prove" a candidate that is already dead, and promotion would then kill
    // the only opencode the box has. Decline instead, loudly.
    if (await checkReady(candidatePort)) {
      logger.error('[opencode] candidate port already answers; port pair is desynced, keeping the running instance', {
        livePort: livePort(),
        candidatePort,
        pid: child?.pid ?? null,
      })
      return { ok: false, reason: `port ${candidatePort} already answers; the port pair is desynced` }
    }
    let candidate: ChildProcess
    try {
      candidate = await spawnChild(binaryPath, { port: candidatePort, supervise: false })
    } catch (err) {
      return { ok: false, reason: `could not spawn candidate: ${(err as Error).message}` }
    }

    // Fault injection (see the `verify_fail` note on POST /kortix/refresh).
    // Deliberately applied AFTER the real spawn and probe, not instead of them:
    // the point is to exercise the ACTUAL decline path — candidate spawned,
    // candidate retired, incumbent untouched — rather than a shortcut that
    // proves only the plumbing.
    const candidateReady = await probeUntilReady(candidatePort, VERIFY_READY_TIMEOUT_MS, candidate)
    const ready = candidateReady && !opts.forceFail
    if (!ready) {
      await killProcessGroup(candidate, 'SIGTERM').catch(() => {})
      logger.warn('[opencode] candidate never became ready; keeping the running instance', {
        candidatePort,
      })
      return { ok: false, reason: 'the new opencode did not start; the previous one is still running' }
    }
    logger.info('[opencode] candidate config verified', { candidatePort })
    return { ok: true, candidate, port: candidatePort }
  }

  /**
   * Poll the real session API until the candidate serves it.
   *
   * Same probe the ordinary readiness check uses, for the reason it documents:
   * opencode binds its port seconds before the project directory is usable, so
   * a plain TCP or health check would call a half-open process "ready" and we
   * would swap onto something that cannot answer a prompt.
   *
   * Gives up early if the candidate dies — no point waiting out the full
   * timeout on a process that already exited.
   */
  async function probeUntilReady(
    port: number,
    timeoutMs: number,
    proc: ChildProcess,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (stopping) return false
      if (proc.exitCode !== null || proc.signalCode !== null) return false
      if (await probeOpencodeSessionApi(`http://127.0.0.1:${port}`, currentCfg.projectTarget, 2_000)) {
        return true
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  /**
   * Close the turn the retired opencode took with it, and report whether there
   * was one. Returns null when it could not be determined.
   *
   * Idempotent: `options.onUnplannedRespawn` (main.ts's `finalizeOrphanedTurn`)
   * skips a turn that already carries `info.error` — already finalized by a
   * prior abort — so repeated replacements over the same stuck turn call
   * `/abort` at most once, not once per replacement.
   */
  async function finalizeAfterReplacement(): Promise<boolean | null> {
    if (!options.onUnplannedRespawn) return null
    const ready = await waitUntilReady(RESPAWN_FINALIZE_TIMEOUT_MS)
    if (!ready) {
      logger.warn('[opencode] replaced but never became ready; orphaned turn left as-is')
      return null
    }
    try {
      const ended = await options.onUnplannedRespawn()
      return ended === true
    } catch (err) {
      logger.warn('[opencode] post-swap finalize hook threw', { err: (err as Error).message })
      return null
    }
  }

  async function checkReady(port = livePort()): Promise<boolean> {
    return probeOpencodeSessionApi(`http://127.0.0.1:${port}`, currentCfg.projectTarget, 2_000)
  }

  /**
   * Rewrite the config file and ask opencode to re-read it in place. True when
   * it did.
   *
   * Measured against opencode 1.17.11 on 2026-08-03, re-verified on the
   * pinned 1.18.19 on 2026-08-20 (same pid after dispose, JSON `true` body,
   * phantom route still answers 200 text/html):
   *   - `POST /global/dispose` re-reads the config file from disk, in-process,
   *     same pid, in ~51ms. A respawn is ~8s.
   *   - There is NO config file watcher. Rewriting the file alone changes
   *     nothing — verified over 18s on a fresh process. Every edit needs its
   *     own dispose.
   *   - `POST /kortix/services/system/reload`, which the SDK calls, does NOT
   *     exist: it falls through to opencode's SPA catch-all and answers 200
   *     text/html. Hence `/global/dispose` directly.
   */
  async function tryDisposeReload(): Promise<boolean> {
    // The SAME env spawnChild composes the config from, so a dispose and a
    // respawn can never disagree about what the config should be.
    const baseEnv = currentProjectEnv
      ? mergeProjectEnv(process.env, currentProjectEnv)
      : process.env
    const written = await writeKortixOpencodeConfig(baseEnv, {
      configPath: options.configPathOverride,
    }).catch((err) => {
      logger.warn('[opencode] could not rewrite config for reload', {
        err: (err as Error).message,
      })
      return null
    })
    if (!written) return false
    try {
      const res = await fetch(
        `http://127.0.0.1:${livePort()}/global/dispose`,
        { method: 'POST', signal: AbortSignal.timeout(15_000) },
      )
      // Content-type matters: the SPA catch-all also answers 200, so a status
      // check alone cannot tell the real endpoint from the web UI.
      // Case-insensitive, and `application/<vendor>+json` counts — a false
      // negative here would fall back to an ~8s respawn for no reason.
      const isJson = /^application\/([\w.+-]+\+)?json\b/i.test(
        (res.headers.get('content-type') ?? '').trim(),
      )
      // And the BODY matters: the endpoint answers `true` on success. A JSON
      // `false` (or an error object) with a 200 would otherwise be read as
      // "reloaded" and skip the fallback, leaving the old config running while
      // we reported success.
      const body = res.ok && isJson ? await res.json().catch(() => null) : null
      if (body === true) {
        logger.info('[opencode] config reloaded via dispose (no respawn)')
        return true
      }
      logger.info('[opencode] dispose did not confirm; falling back to restart', {
        status: res.status,
        contentType: res.headers.get('content-type'),
      })
    } catch (err) {
      logger.info('[opencode] dispose failed; falling back to restart', {
        err: (err as Error).message,
      })
    }
    return false
  }

  /**
   * Resolve once opencode is answering again, or false if it never does.
   *
   * Only the post-respawn turn finalize uses this. Bounded, because the caller
   * is cleanup: a box that came back but stayed unhealthy has bigger problems
   * than a stuck spinner, and a hook that waited forever would keep a timer
   * alive across every subsequent restart.
   */
  async function waitUntilReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (stopping) return false
      if (state === 'ok' || (await checkReady())) return true
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
    return false
  }

  function scheduleReadinessProbe() {
    if (stopping) return
    // Poll fast until ready (quick boot detection), then slow to a liveness ping.
    // The forever-100ms poll cost ~55% of a core per idle sandbox (READY_LIVENESS_MS).
    // Once ok, probe slowly (liveness). But the moment a liveness probe starts
    // failing, re-probe faster so a real wedge downgrades quickly AND a busy
    // opencode's recovery is seen quickly — without ever gating it off on one blip.
    const interval =
      state === 'ok'
        ? livenessFailures > 0
          ? READY_LIVENESS_RECHECK_MS
          : READY_LIVENESS_MS
        : READY_POLL_MS
    readinessTimer = setTimeout(async () => {
      if (stopping) return
      const probedPort = livePort()
      const probedChild = child
      const ready = await checkReady(probedPort)
      if (stopping) return
      if (probedPort !== livePort()) {
        scheduleReadinessProbe()
        return
      }
      if (probedChild !== child) {
        scheduleReadinessProbe()
        return
      }
      if (ready) {
        if (livenessFailures > 0) {
          logger.info('[opencode] liveness recovered', { afterFailures: livenessFailures })
        }
        if (probedChild) reportReadyResponse(probedChild)
        livenessFailures = 0
        markReady()
      } else {
        const decision = nextLivenessState({
          state,
          ready: false,
          consecutiveFailures: livenessFailures,
          threshold: READY_LIVENESS_DOWNGRADE_THRESHOLD,
        })
        livenessFailures = decision.consecutiveFailures
        if (decision.downgraded) {
          logger.warn('[opencode] liveness failed repeatedly; marking not-ready', {
            consecutiveFailures: livenessFailures,
            threshold: READY_LIVENESS_DOWNGRADE_THRESHOLD,
            port: probedPort,
          })
        }
        state = decision.state
      }
      scheduleReadinessProbe()
    }, interval)
  }


  return {
    prefetchBinary() {
      if (!binaryPrefetchPromise) {
        const controller = new AbortController()
        binaryPrefetchController = controller
        binaryPrefetchPromise = prefetchBinaryOnce(controller.signal).finally(() => {
          if (binaryPrefetchController === controller) binaryPrefetchController = null
        })
      }
      return binaryPrefetchPromise
    },

    cancelBinaryPrefetch() {
      binaryPrefetchController?.abort()
    },

    async start() {
      stopping = false
      state = 'starting'
      const bin = await resolveBinaryPath()
      if (!bin) {
        logger.warn('[opencode] binary not found; daemon will continue, opencode reports as starting')
        state = 'starting'
        scheduleReadinessProbe()
        return
      }
      opencodeCwd = await resolveOpencodeCwd(currentCfg)
      startupMark('runtime-cwd-resolved')
      try {
        await spawnChild(bin)
      } catch (err) {
        // A failed spawn produces NO process, so no 'exit' ever fires and the
        // crash path that normally rescues opencode never runs. Left as a bare
        // log, this permanently killed the session: `restart()` stops the
        // WORKING opencode first, so a spawn that then fails — a full disk, a
        // PID/memory ceiling — leaves the box reporting `starting` forever with
        // every prompt 503ing, while `/kortix/env` answered ok:true and the
        // reload reported success. Recovering needed a whole new session, with
        // nothing anywhere saying the restart was what killed it.
        //
        // `scheduleUnplannedRespawn` is exactly the right recovery and already
        // self-reschedules with backoff up to 30s; the planned path simply
        // never called it.
        logger.error('[opencode] spawn failed; scheduling respawn', err)
        state = 'down'
        scheduleUnplannedRespawn()
      }
      scheduleReadinessProbe()
    },

    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      stopping = true
      state = 'down'
      readyResponseProcess = null
      if (readinessTimer) {
        clearTimeout(readinessTimer)
        readinessTimer = null
      }
      binaryPrefetchController?.abort()
      if (binaryPrefetchPromise) await binaryPrefetchPromise
      if (!child) return
      const c = child
      // Spawned with detached: true, so c.pid also identifies the process
      // group opencode leads — signal the whole group (-pid), not just this
      // direct child, so a grandchild opencode forks (e.g. its own `bun
      // install` for the config dir) can't outlive the kill and race a
      // freshly-spawned opencode's install into the same directory. Falls
      // back to a plain child kill if the group signal itself throws.
      const killGroup = (sig: NodeJS.Signals) => {
        if (c.pid) {
          try {
            process.kill(-c.pid, sig)
            return
          } catch {}
        }
        c.kill(sig)
      }
      return new Promise<void>((resolve) => {
        const onExit = () => resolve()
        c.once('exit', onExit)
        try {
          killGroup(signal)
        } catch {
          resolve()
          return
        }
        // Hard kill if the child (or its group) ignores SIGTERM.
        setTimeout(() => {
          try {
            killGroup('SIGKILL')
          } catch {}
          resolve()
        }, 5_000).unref()
      })
    },

    async restart() {
      await this.stop('SIGTERM')
      restartDelayMs = 500
      await this.start()
      // A PLANNED restart strands its turn exactly like a crash does, and only
      // the crash path was cleaning up: `proc.on('exit')` returns early while
      // `stopping` is set — which `stop()` sets and this goes through — so
      // `onUnplannedRespawn`, and with it the orphaned-turn finalize, never
      // fired for a restart we asked for.
      //
      // A turn ends only when opencode emits `session.idle`/`session.error` over
      // SSE. The opencode we just killed emits neither, so the last assistant
      // message stays incomplete and every client streaming it spins forever.
      // `reload --force` is the sharpest case: it exists precisely to reload
      // DURING a turn, and its confirmation tells the user it "ends the turn
      // that's running right now" — then left it spinning instead of ended.
      // `/kortix/refresh` (restart on by default) and `sessions restart` reach
      // the same place.
      //
      // Unconditional because `finalizeOrphanedTurn` already distinguishes: it
      // aborts only a last message that is an assistant turn with no completion
      // time, and leaves a completed turn, a user-last session, and an empty one
      // alone. Readiness is awaited first for the reason the crash path
      // documents — firing before opencode listens makes the hook read "no turn
      // to finalize" and silently do nothing in the exact case it exists for.
      if (!options.onUnplannedRespawn) return
      const ready = await waitUntilReady(RESPAWN_FINALIZE_TIMEOUT_MS)
      if (!ready) {
        logger.warn('[opencode] restarted but never became ready; orphaned turn left as-is')
        return
      }
      try {
        options.onUnplannedRespawn()
      } catch (err) {
        logger.warn('[opencode] post-restart finalize hook threw', {
          err: (err as Error).message,
        })
      }
    },

    /**
     * Apply the current env's config, without a respawn when opencode allows it.
     *
     * Falls back to a full restart whenever dispose is unavailable or fails, so
     * a future opencode that drops the endpoint degrades to today's behaviour
     * rather than silently not applying the config.
     */
    async reloadConfig(opts: { mustRespawn?: boolean } = {}): Promise<ReloadConfigResult> {
      // A dispose re-reads the config in place — same process, no turn lost.
      if (!opts.mustRespawn && (await tryDisposeReload())) {
        return { how: 'disposed', turnEnded: false }
      }
      // Verified swap instead of the old kill-then-hope restart. A config that
      // cannot boot now leaves the running opencode in place and reports why,
      // rather than taking the session down with it.
      const result = await this.reloadVerified()
      if (result.outcome === 'kept-old') {
        logger.warn('[opencode] reload kept the previous instance', { reason: result.reason })
        // Nothing was replaced, so nothing was interrupted.
        return { how: 'kept-old', turnEnded: false }
      }
      // No finalize here: reloadVerified() owns it now, so /kortix/refresh —
      // which calls it directly — stops stranding the turn it interrupts.
      return { how: 'restarted', turnEnded: result.turnEnded }
    },

    /** Promote the verified process before retiring the previous process. */
    async reloadVerified(opts: { forceFail?: boolean } = {}): Promise<VerifiedReloadResult> {
      const proven = await verifyCandidateBoots(opts)
      if (!proven.ok) return { outcome: 'kept-old', reason: proven.reason }

      const previous = child
      const previousPort = livePort()
      activePort = proven.port
      child = proven.candidate
      superviseChild(proven.candidate)
      if (proven.candidate.exitCode !== null || proven.candidate.signalCode !== null) {
        child = previous
        activePort = previousPort
        return {
          outcome: 'kept-old',
          reason: 'the verified opencode exited before promotion; the previous one is still running',
        }
      }
      reportReadyResponse(proven.candidate)
      markReady()
      if (previous) await killProcessGroup(previous, 'SIGTERM').catch(() => {})
      logger.info('[opencode] candidate promoted', {
        port: activePort,
        pid: proven.candidate.pid,
        previousPort,
        previousPid: previous?.pid ?? null,
      })

      // Finalize HERE, not in reloadConfig.
      //
      // A turn ends only when opencode emits session.idle/session.error over
      // SSE. The process we just retired emits neither, so its last assistant
      // message stays incomplete and every client streaming it spins forever.
      // reloadConfig used to own this, which left `/kortix/refresh` — the one
      // route that calls reloadVerified directly — stranding the turn it
      // interrupted. Retiring the process and closing its turn belong together.
      const turnEnded = await finalizeAfterReplacement()

      return {
        outcome: 'swapped',
        port: activePort,
        pid: this.getPid(),
        turnEnded,
      }
    },

    reconfigure(nextCfg: Config, nextOpencodeConfigDir: string, nextProjectEnv?: ProjectEnvStore) {
      currentCfg = nextCfg
      if (
        activePort !== nextCfg.opencodeInternalPort &&
        activePort !== nextCfg.opencodeStandbyPort
      ) {
        activePort = nextCfg.opencodeInternalPort
      }
      currentOpencodeConfigDir = nextOpencodeConfigDir
      if (nextProjectEnv) currentProjectEnv = nextProjectEnv
      state = 'starting'
      logger.info('[opencode] reconfigured', {
        projectId: nextCfg.projectId,
        opencodeConfigDir: nextOpencodeConfigDir,
      })
    },

    getPid() {
      return child?.pid ?? null
    },

    getActivePort() {
      return livePort()
    },

    getInternalUrl() {
      return `http://127.0.0.1:${livePort()}`
    },

    getBinaryPath() {
      return binaryPath
    },

    getState() {
      return state
    },

    markReady,

    waitForCurrentReadyResponse() {
      if (!stopping && child && readyResponseProcess === child) return Promise.resolve()
      return new Promise<void>((resolve) => {
        readyResponseWaiters.add(resolve)
      })
    },
  }
}

/**
 * Probe the same OpenCode API the app needs. A plain process/HTTP health route
 * is too weak because OpenCode can bind while the project directory is still
 * unusable for real session APIs.
 */
async function probeOpencodeSessionApi(
  baseUrl: string,
  directory: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(directory)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

/**
 * Tail-readiness probe used at boot to deadline-bound the first ready state.
 * Returns true if opencode reported ready before the deadline, false otherwise.
 * Non-throwing — the daemon should boot even on false so we can report `starting`.
 */
export async function waitForOpencodeReady(
  opencode: Opencode,
  directory?: string,
  // Boot-profiling hook: fired once the moment opencode's port answers ANY
  // HTTP (process bound + listening), which is strictly before /session serves
  // 200 (== ready). The gap between this and `opencode-ready` localizes the
  // cold-start cost: a big spawn→listening gap = process/runtime startup; a big
  // listening→ready gap = opencode's internal app/session init.
  onListening?: () => void,
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let listeningSeen = false
  while (Date.now() < deadline) {
    if (opencode.getState() === 'ok') return true
    if (directory) {
      const probe = await probeOpencodeReadiness(opencode.getInternalUrl(), directory, 500)
      if (probe !== 'down' && !listeningSeen) {
        listeningSeen = true
        onListening?.()
      }
      if (probe === 'ready') {
        opencode.markReady()
        return true
      }
    }
    await new Promise((r) => setTimeout(r, directory ? BOOT_READY_POLL_MS : READY_POLL_MS))
  }
  return false
}

/** Richer boot probe: 'down' = port not answering at all, 'listening' = answers
 *  HTTP but /session not 2xx yet, 'ready' = /session 2xx/3xx. */
async function probeOpencodeReadiness(
  baseUrl: string,
  directory: string,
  timeoutMs: number,
): Promise<'down' | 'listening' | 'ready'> {
  try {
    const res = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(directory)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.status >= 200 && res.status < 400 ? 'ready' : 'listening'
  } catch {
    return 'down'
  }
}
