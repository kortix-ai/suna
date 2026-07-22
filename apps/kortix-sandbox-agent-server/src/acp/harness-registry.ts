import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildOpencodeKortixProvider, DEFAULT_KORTIX_MODEL } from './opencode-gateway'

export const ACP_HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const

export type AcpHarnessId = (typeof ACP_HARNESS_IDS)[number]

export type RuntimeAuthKind =
  | 'managed_gateway'
  | 'claude_subscription'
  | 'anthropic_api_key'
  | 'codex_subscription'
  | 'openai_api_key'
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'native_config'

const PROVIDER_CREDENTIAL_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_AUTH_JSON',
  'OPENCODE_AUTH_JSON',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CUSTOM_LLM_PROTOCOL',
  'CUSTOM_LLM_BASE_URL',
  'CUSTOM_LLM_API_KEY',
  'CUSTOM_LLM_MODEL_ID',
] as const

const AUTH_ENV_BY_KIND: Record<RuntimeAuthKind, readonly string[]> = {
  managed_gateway: [],
  claude_subscription: ['CLAUDE_CODE_OAUTH_TOKEN'],
  anthropic_api_key: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex_subscription: ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON'],
  openai_api_key: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  openai_compatible: ['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_MODEL_ID'],
  anthropic_compatible: ['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_MODEL_ID'],
  native_config: [],
}

function runtimeAuthKind(env: NodeJS.ProcessEnv): RuntimeAuthKind | null {
  const value = env.KORTIX_RUNTIME_AUTH_KIND?.trim()
  return value && Object.prototype.hasOwnProperty.call(AUTH_ENV_BY_KIND, value)
    ? value as RuntimeAuthKind
    : null
}

/** Limit each ACP child to the explicitly selected provider credential. Old
 * sessions without KORTIX_RUNTIME_AUTH_KIND retain legacy discovery so they can
 * still be resumed and then migrated. */
export function isolateHarnessAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kind = runtimeAuthKind(env)
  if (!kind) return { ...env }
  const out = { ...env }
  for (const name of PROVIDER_CREDENTIAL_ENV) delete out[name]
  // Native config is an explicit authentication source. It must not inherit
  // whichever provider secrets happen to exist at project scope.
  if (kind === 'native_config') return out
  for (const name of AUTH_ENV_BY_KIND[kind]) {
    if (env[name] != null) out[name] = env[name]
  }
  return out
}

export type AcpHarnessLaunch = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type AcpHarnessDescriptor = {
  id: AcpHarnessId
  displayName: string
  adapter: string
  launch: AcpHarnessLaunch
}

export type AcpHarnessRegistry = ReadonlyMap<AcpHarnessId, AcpHarnessDescriptor>

function nativeConfigEnv(id: AcpHarnessId, env: NodeJS.ProcessEnv): Record<string, string> {
  const dir = nativeConfigDir(env, id)
  if (!dir) return {}
  if (id === 'claude') return { CLAUDE_CONFIG_DIR: dir }
  if (id === 'codex') return { CODEX_HOME: dir }
  if (id === 'opencode') return { OPENCODE_CONFIG_DIR: dir }
  return { PI_CODING_AGENT_DIR: dir }
}

// Mirrors LEGACY_OPENCODE_CONFIG_DIR in apps/api/src/projects/git/config.ts —
// the two packages don't share imports, so this is intentionally duplicated
// rather than pulled through a shared module.
const LEGACY_OPENCODE_CONFIG_DIR = '.kortix/opencode'

export function nativeConfigDir(env: NodeJS.ProcessEnv, harness?: AcpHarnessId): string | null {
  const raw = env.KORTIX_RUNTIME_CONFIG_DIR?.trim()
  if (!raw) return null
  const workspace = env.KORTIX_WORKSPACE?.replace(/\/$/, '') || '/workspace'
  const dir = raw.startsWith('/') ? raw : `${workspace}/${raw.replace(/^\.\//, '')}`
  if (harness === 'opencode' && !existsSync(join(dir, 'opencode.jsonc'))) {
    const legacy = join(workspace, LEGACY_OPENCODE_CONFIG_DIR)
    if (existsSync(join(legacy, 'opencode.jsonc'))) return legacy
  }
  return dir
}

/** Resolve the native config dir for the harness named by KORTIX_RUNTIME_HARNESS
 * — the same variable the boot sequence (main.ts) uses to pick the ACP child.
 * This is the seam boot-time work that runs outside an ACP session (e.g. the
 * managed-skills injection) must call instead of `nativeConfigDir(env)` with no
 * harness: without it, a legacy `.kortix/opencode` workspace gets skills
 * injected into `.opencode` while the opencode child — via
 * `resolveAcpHarnessLaunchEnv('opencode', …)` — reads config from
 * `.kortix/opencode`, silently defeating the injection. */
export function nativeConfigDirForRuntimeHarness(env: NodeJS.ProcessEnv): string | null {
  const harness = parseAcpHarnessId(env.KORTIX_RUNTIME_HARNESS)
  return nativeConfigDir(env, harness ?? undefined)
}

function codexProfileConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const activeHarness = env.KORTIX_RUNTIME_HARNESS?.trim()
  if (activeHarness && activeHarness !== 'codex') return {}
  const profile = env.KORTIX_NATIVE_AGENT?.trim()
  if (!profile) return {}
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error('KORTIX_NATIVE_AGENT is not a safe Codex profile identifier')
  }
  const home = nativeConfigDir(env)
  // Registry construction evaluates every harness for diagnostics. A logical
  // agent that belongs to another harness must not make that snapshot fail.
  // Actual Codex launches always receive the compiler-resolved config dir.
  if (!home) return {}
  const path = join(home, `${profile}.config.toml`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Codex profile '${profile}' was not found at ${path}`)
  }
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(raw)
  } catch (error) {
    throw new Error(`Codex profile '${profile}' is invalid TOML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Codex profile '${profile}' must contain a TOML table`)
  }
  return parsed as Record<string, unknown>
}

type AcpSessionEnvelope = {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: unknown
  [key: string]: unknown
}

/** Apply only adapter-sanctioned launch metadata. The generic ACP client stays
 * harness-neutral; native routing belongs at this final harness boundary. */
export function applyAcpSessionDefaults(
  harness: AcpHarnessId,
  envelope: AcpSessionEnvelope,
  env: NodeJS.ProcessEnv,
): AcpSessionEnvelope {
  if (harness !== 'claude' || (envelope.method !== 'session/new' && envelope.method !== 'session/load')) {
    return envelope
  }
  const agent = env.KORTIX_NATIVE_AGENT?.trim()
  if (!agent) return envelope
  const params = envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
    ? envelope.params as Record<string, unknown>
    : {}
  const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
    ? params._meta as Record<string, unknown>
    : {}
  const claudeCode = meta.claudeCode && typeof meta.claudeCode === 'object' && !Array.isArray(meta.claudeCode)
    ? meta.claudeCode as Record<string, unknown>
    : {}
  const options = claudeCode.options && typeof claudeCode.options === 'object' && !Array.isArray(claudeCode.options)
    ? claudeCode.options as Record<string, unknown>
    : {}
  return {
    ...envelope,
    params: {
      ...params,
      _meta: {
        ...meta,
        claudeCode: {
          ...claudeCode,
          options: { ...options, agent },
        },
      },
    },
  }
}

// Sane fallback PATH matching what the Dockerfile actually installs into
// (`/usr/local/bin` for npm-global harness binaries and the toolchain, plus
// the standard Debian/Ubuntu system dirs). Only used when the process env's
// own PATH is empty/unset — see the `id === 'pi'` and `id === 'opencode'`
// branches of resolveAcpHarnessLaunchEnv for why that happens on Platinum.
const HARNESS_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

const DEFAULTS: Record<AcpHarnessId, Omit<AcpHarnessDescriptor, 'id'>> = {
  claude: {
    displayName: 'Claude Code',
    adapter: '@agentclientprotocol/claude-agent-acp',
    launch: {
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
    },
  },
  codex: {
    displayName: 'Codex',
    adapter: '@agentclientprotocol/codex-acp',
    launch: {
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js'],
    },
  },
  opencode: {
    displayName: 'OpenCode',
    adapter: 'native',
    launch: { command: 'opencode', args: ['acp'] },
  },
  pi: {
    displayName: 'Pi',
    adapter: 'pi-acp',
    launch: {
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/pi-acp/dist/index.js'],
    },
  },
}

function envPrefix(id: AcpHarnessId): string {
  return `KORTIX_ACP_${id.toUpperCase()}`
}

function customProvider(env: NodeJS.ProcessEnv): {
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  apiKey?: string
  model?: string
} | null {
  const protocol = env.CUSTOM_LLM_PROTOCOL?.trim().toLowerCase()
  const baseUrl = env.CUSTOM_LLM_BASE_URL?.trim().replace(/\/+$/, '')
  if ((protocol !== 'openai' && protocol !== 'anthropic') || !baseUrl) return null
  return {
    protocol,
    baseUrl,
    ...(env.CUSTOM_LLM_API_KEY?.trim() ? { apiKey: env.CUSTOM_LLM_API_KEY.trim() } : {}),
    ...(env.CUSTOM_LLM_MODEL_ID?.trim() ? { model: env.CUSTOM_LLM_MODEL_ID.trim() } : {}),
  }
}

function argsFromEnv(id: AcpHarnessId, fallback: string[], env: NodeJS.ProcessEnv): string[] {
  const raw = env[`${envPrefix(id)}_ARGS`]?.trim()
  if (!raw) return fallback
  // ARGS is parsed as JSON only — never handed to a shell for tokenization —
  // so a malformed value can only fail closed with a clear, actionable error,
  // never partially/ambiguously "parse" into something a shell would have
  // split differently.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${envPrefix(id)}_ARGS must be a JSON string array (e.g. '["--flag"]'); ` +
        `got invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${envPrefix(id)}_ARGS must be a JSON string array`)
  }
  return parsed
}

export function resolveAcpHarnessLaunchEnv(id: AcpHarnessId, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const outerNative = nativeConfigEnv(id, env)
  const native = outerNative
  const apiUrl = env.KORTIX_API_URL?.replace(/\/$/, '')
  const token = env.KORTIX_TOKEN?.trim()
  const custom = customProvider(env)
  const runtimeModel = env.KORTIX_RUNTIME_MODEL?.trim()
  const authKind = runtimeAuthKind(env)
  if (id === 'opencode') {
    // Platinum microVMs have been observed booting the ENTIRE sandbox process
    // tree with NO `PATH` env var at all (see the `id === 'pi'` branch below
    // for the full live-verified writeup). OpenCode is hit HARDER than the
    // other harnesses by this: unlike claude-agent-acp/codex-acp/pi-acp
    // (Node entrypoints launched by absolute path), `AcpProcess` spawns
    // OpenCode by its BARE command name (`DEFAULTS.opencode.launch.command
    // === 'opencode'`, resolved via runtime.ts's `spawn()`) — with no PATH at
    // all, that lookup fails immediately with Bun's own
    // `Executable not found in $PATH: "opencode"`, before the harness ever
    // gets a chance to run. Only inject a fallback when PATH is genuinely
    // absent; a real (possibly customized) PATH from the host env always
    // wins. Reassigned (not mutated) so every return path below — including
    // the two early returns — carries it.
    const native = { ...outerNative, PATH: env.PATH?.trim() || HARNESS_DEFAULT_PATH }
    const nativeAgent = env.KORTIX_NATIVE_AGENT?.trim()
    if (authKind === 'codex_subscription') {
      // 2026-07-22 Codex-subscription widening. OpenCode is NOT pointed at a
      // bespoke translation endpoint — it keeps its NORMAL Kortix managed-gateway
      // provider (`buildOpencodeKortixProvider`: baseURL = the in-process
      // `/v1/llm` gateway, apiKey = the per-session executor PAT). The ONLY
      // difference from a managed_gateway session is the model set: instead of
      // the full gateway catalog, OpenCode is given the ChatGPT-backend codex
      // model(s) in the gateway's `codex/*` namespace (default
      // `kortix/codex/gpt-5.6-sol`).
      //
      // The gateway itself does the rest, with zero new code: a chat-completions
      // request carrying `model: codex/<id>` routes through the AI-SDK gateway's
      // existing `codex/*` path (`resolve-candidates.ts` → provider === 'codex'),
      // which resolves the CALLER's OWN Codex OAuth credential server-side
      // (`resolveCodexCredential(principal.projectId, principal.userId)` — the
      // executor PAT resolves to exactly that principal) and drives the ChatGPT
      // Responses backend via the AI SDK's OpenAI `.responses()` model (the chat
      // ↔ Responses translation is the SDK's, maintained by Vercel, and already
      // sets `store: false` for `openai-codex`). `codexDescriptor`'s
      // `billingMode: 'none'` means zero Kortix credits are deducted — proven
      // live 2026-07-22: a `codex/gpt-5.6-sol` completion booked `cost_usd = 0`
      // and no `credit_ledger` row. So OpenCode gets the subscription for free,
      // using the same gateway lane the modern `codex/*` models already ride —
      // no relay, no translator, no billing bypass.
      //
      // The executor PAT (KORTIX_LLM_API_KEY) is what makes this custody-safe:
      // it carries the launching user's project/user id, so the gateway resolves
      // THAT user's credential and never a Kortix platform key. Fail closed if
      // the gateway env is absent rather than silently degrading.
      const gatewayProvider = buildOpencodeKortixProvider(env)
      if (!gatewayProvider) {
        // The active OpenCode launch with the gateway env missing is a real
        // misconfiguration — fail closed (no silent Zen-only fallback). But
        // `createAcpHarnessRegistry` eagerly evaluates EVERY harness for its
        // diagnostic snapshot: a codex_subscription session whose ACTIVE harness
        // is codex/pi (the raw-relay lane, which legitimately has no KORTIX_LLM_*)
        // must not have opencode's branch throw and break the active harness's
        // launch. So only throw when OpenCode is the harness actually being
        // launched; otherwise degrade to native like the managed_gateway branch
        // below does when its provider can't be built. There is no billing-leak
        // risk either way: OpenCode's codex lane is the SAME gateway + executor
        // PAT a managed session uses — a missing gateway just yields no provider,
        // never a Kortix-billed fallback.
        if (env.KORTIX_RUNTIME_HARNESS?.trim() === 'opencode') {
          throw new Error(
            'Codex subscription auth for OpenCode requires the Kortix LLM gateway env ' +
              '(KORTIX_LLM_BASE_URL + KORTIX_LLM_API_KEY, the per-session executor PAT); ' +
              'refusing to fall back to a non-subscription route.',
          )
        }
        return Object.keys(native).length ? native : undefined
      }
      // Canonical `codex/<id>` grammar so the gateway's resolve-candidates sees
      // provider === 'codex'. A caller-selected `runtimeModel` (fed from the
      // advertised set the composer resolves via resolveHarnessModels, already
      // `codex/`-prefixed for OpenCode's gateway-prefixed namespacing) wins;
      // normalize either shape to exactly one `codex/` prefix.
      const codexModel = `codex/${(runtimeModel || 'codex/gpt-5.6-sol').replace(/^codex\//, '')}`
      let existing: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
      } catch {
        // Invalid inherited content must not suppress manifest-selected routing.
      }
      return {
        ...native,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...existing,
          provider: {
            ...(existing.provider && typeof existing.provider === 'object' && !Array.isArray(existing.provider)
              ? (existing.provider as Record<string, unknown>)
              : {}),
            // Same npm/options (baseURL=/v1/llm, apiKey=executor PAT) as the
            // managed provider — only the model set and display name change.
            kortix: {
              ...gatewayProvider,
              name: 'Kortix Codex Subscription',
              models: {
                [codexModel]: {
                  name: codexModel,
                  reasoning: true,
                  tool_call: true,
                  attachment: true,
                  temperature: false,
                  limit: { context: 400_000, output: 128_000 },
                },
              },
            },
          },
          enabled_providers: ['kortix'],
          model: `kortix/${codexModel}`,
          small_model: `kortix/${codexModel}`,
          ...(nativeAgent ? { default_agent: nativeAgent } : {}),
        }),
      }
    }
    const gatewayProvider =
      custom || (authKind && authKind !== 'managed_gateway')
        ? null
        : buildOpencodeKortixProvider(env)
    if (authKind === 'managed_gateway' && !gatewayProvider) {
      return Object.keys(native).length ? native : undefined
    }
    if (!nativeAgent && !runtimeModel && custom?.protocol !== 'openai' && !gatewayProvider) {
      return Object.keys(native).length ? native : undefined
    }
    let existing: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
    } catch {
      // Invalid inherited content must not suppress manifest-selected routing.
    }
    const customConfig =
      custom?.protocol === 'openai'
        ? {
            provider: {
              custom: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Custom REST provider',
                options: {
                  baseURL: custom.baseUrl,
                  ...(custom.apiKey ? { apiKey: custom.apiKey } : {}),
                },
                ...(custom.model ? { models: { [custom.model]: { name: custom.model } } } : {}),
              },
            },
          }
        : {}
    const gatewayConfig = gatewayProvider
      ? {
          provider: {
            ...(existing.provider && typeof existing.provider === 'object' && !Array.isArray(existing.provider)
              ? existing.provider as Record<string, unknown>
              : {}),
            kortix: gatewayProvider,
          },
          enabled_providers: ['kortix'],
          model:
            typeof existing.model === 'string' && existing.model.startsWith('kortix/')
              ? existing.model
              : DEFAULT_KORTIX_MODEL,
          small_model:
            typeof existing.small_model === 'string' && existing.small_model.startsWith('kortix/')
              ? existing.small_model
              : DEFAULT_KORTIX_MODEL,
        }
      : {}
    return {
      ...native,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...existing,
        ...customConfig,
        ...gatewayConfig,
        ...(runtimeModel ? { model: runtimeModel } : {}),
        ...(nativeAgent ? { default_agent: nativeAgent } : {}),
      }),
    }
  }
  if (id === 'codex') {
    const profileConfig = codexProfileConfig(env)
    const withModel = (model: string | undefined, fallback?: string) => ({
      ...profileConfig,
      ...((model || (typeof profileConfig.model !== 'string' && fallback))
        ? { model: model || fallback }
        : {}),
    })
    // Direct API keys are consumed natively by codex-acp. Subscription auth
    // (below) is intentionally different: CODEX_AUTH_JSON stays server-side
    // where the Kortix gateway can refresh it, and the adapter authenticates
    // to a dedicated relay with the per-session executor token instead.
    if (authKind === 'native_config') {
      const direct = {
        ...native,
        ...(Object.keys(profileConfig).length ? { CODEX_CONFIG: JSON.stringify(profileConfig) } : {}),
      }
      return Object.keys(direct).length ? direct : undefined
    }
    if (authKind === 'codex_subscription') {
      // CODEX_AUTH_JSON is NEVER read here, and must not be: the user's OAuth
      // blob is resolved + refreshed entirely server-side (resolveCodexCredential,
      // apps/api/src/llm-gateway/credentials/codex.ts) and the access token
      // never leaves the API process. The adapter is pointed at a dedicated
      // Kortix-hosted relay — /router/codex-subscription — NOT the generic
      // Kortix-managed-key `/router/openai` proxy used by the default branch
      // below: that path injects KORTIX'S OWN OPENAI_API_KEY/OPENROUTER_API_KEY
      // and bills Kortix credits at 1.2x, completely bypassing a connected
      // subscription (see docs/specs/2026-07-21-codex-billing-leak-verification.md).
      // /router/codex-subscription instead resolves the CALLER's own Codex
      // credential and bills nothing.
      //
      // Authenticates with the per-session EXECUTOR token (kortix_pat_…,
      // carries the launching user's project/user id — see session-sandbox.ts's
      // KORTIX_CLI_TOKEN/KORTIX_EXECUTOR_TOKEN), never the bare sandbox token
      // (KORTIX_TOKEN, kortix_sb_…): the router route only accepts an account
      // token that resolves to a projectId/userId, and a sandbox token cannot
      // — see codex-subscription.ts's validateAccountToken check.
      const executorToken = (env.KORTIX_EXECUTOR_TOKEN || env.KORTIX_CLI_TOKEN)?.trim()
      if (!apiUrl || !executorToken) {
        // Fail loudly instead of silently falling through to the generic
        // Kortix-managed-gateway default below — that silent fallback IS the
        // billing leak this branch exists to close, so it must never happen
        // for a subscription-authenticated session, missing credential or not.
        throw new Error(
          'Codex subscription auth requires KORTIX_API_URL and a session executor token ' +
            '(KORTIX_EXECUTOR_TOKEN/KORTIX_CLI_TOKEN); refusing to fall back to the ' +
            'Kortix-managed gateway key for a subscription-authenticated Codex session.',
        )
      }
      return {
        ...native,
        NO_BROWSER: '1',
        // The subscription relay forwards this model id VERBATIM to the
        // ChatGPT/Codex backend, which only accepts codex-acp's own BARE
        // advertised ids (gpt-5.6-sol, gpt-5.5, …). A gateway-style
        // `openai/…`-prefixed id — correct for the Kortix-managed
        // `/router/openai` default branch below — is REJECTED here with
        // `{"detail":"The 'openai/gpt-5.4' model is not supported when using
        // Codex with a ChatGPT account."}` (400), which codex-acp then leaks
        // to the user as a normal assistant message. So the subscription
        // fallback must be a bare, ChatGPT-accepted, ADVERTISED value:
        // `gpt-5.6-sol` is the first option codex-acp itself advertises at
        // session/new (see kortix.acp_session_envelopes) and is proven-good
        // against the live relay (200 + streamed SSE, 2026-07-22). A
        // caller-selected `runtimeModel` (an advertised value the composer
        // fed from the same list) always wins.
        CODEX_CONFIG: JSON.stringify(withModel(runtimeModel, 'gpt-5.6-sol')),
        DEFAULT_AUTH_REQUEST: JSON.stringify({
          methodId: 'gateway',
          _meta: {
            gateway: {
              baseUrl: `${apiUrl}/router/codex-subscription`,
              providerName: 'Kortix Codex Subscription',
              headers: { Authorization: `Bearer ${executorToken}` },
            },
          },
        }),
      }
    }
    if (env.CODEX_API_KEY || env.OPENAI_API_KEY) {
      const direct = {
        ...native,
        ...(runtimeModel || Object.keys(profileConfig).length
          ? { CODEX_CONFIG: JSON.stringify(withModel(runtimeModel)) }
          : {}),
      }
      return Object.keys(direct).length ? direct : undefined
    }
    if (custom?.protocol === 'openai') {
      return {
        ...native,
        NO_BROWSER: '1',
        ...(runtimeModel || custom.model || Object.keys(profileConfig).length
          ? {
              CODEX_CONFIG: JSON.stringify(withModel(runtimeModel || custom.model)),
            }
          : {}),
        DEFAULT_AUTH_REQUEST: JSON.stringify({
          methodId: 'gateway',
          _meta: {
            gateway: {
              baseUrl: custom.baseUrl,
              providerName: 'Custom REST provider',
              ...(custom.apiKey ? { headers: { Authorization: `Bearer ${custom.apiKey}` } } : {}),
            },
          },
        }),
      }
    }
    if (!apiUrl || !token) return Object.keys(native).length ? native : undefined
    return {
      ...native,
      NO_BROWSER: '1',
      CODEX_CONFIG: JSON.stringify(withModel(runtimeModel, 'openai/gpt-5.4')),
      DEFAULT_AUTH_REQUEST: JSON.stringify({
        methodId: 'gateway',
        _meta: {
          gateway: {
            baseUrl: `${apiUrl}/router/openai`,
            providerName: 'Kortix Gateway',
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
    }
  }
  if (id === 'pi') {
    // Platinum microVMs have been observed booting the ENTIRE sandbox process
    // tree — pt-init (pid 1), the entrypoint shell, and the daemon itself —
    // with NO `PATH` env var at all (verified live via /proc/<pid>/environ on
    // a running sandbox). That empty PATH propagates verbatim into every ACP
    // harness child (`{...isolatedEnv, ...launchEnv}` never adds PATH back).
    // For claude-agent-acp/codex-acp this is harmless: they're self-contained
    // ACP-native adapters. `pi-acp` is different — it's a thin protocol
    // wrapper that shells out to the separate `pi` CLI by bare command name
    // (`spawn('pi', …)`). With no PATH, Node's execvp() falls back to a bare
    // glibc default (`/bin:/usr/bin`) that excludes `/usr/local/bin` — where
    // this Dockerfile actually installs `pi` — so the spawn fails ENOENT and
    // pi-acp surfaces it as "Could not start pi: executable not found
    // (command: pi)" even though the binary is present on disk. Only inject a
    // fallback when PATH is genuinely absent; a real (possibly customized)
    // PATH from the host env always wins.
    const native = { ...outerNative, PATH: env.PATH?.trim() || HARNESS_DEFAULT_PATH }
    if (authKind === 'native_config') return Object.keys(native).length ? native : undefined
    if (authKind === 'codex_subscription') {
      // 2026-07-22 Codex-subscription widening. Pi speaks OpenAI Responses
      // natively (`api: 'openai-responses'`), the SAME wire shape codex-acp's
      // subscription session uses — so Pi is pointed at the SAME dedicated
      // relay (`/router/codex-subscription`), NOT the generic Kortix-managed
      // `/router/openai` proxy of the default branch below. That default path
      // injects KORTIX'S OWN OPENAI_API_KEY/OPENROUTER_API_KEY and bills Kortix
      // credits at 1.2x, bypassing the connected subscription entirely; the
      // subscription relay instead resolves the CALLER's OWN Codex OAuth
      // credential server-side (resolveCodexCredential — the token never leaves
      // the API process, never reaches this sandbox) and bills nothing
      // (codexDescriptor's `billingMode: 'none'`). Mirrors the `id === 'codex'`
      // codex_subscription branch above; see
      // apps/api/src/router/routes/proxy/codex-subscription.ts.
      //
      // Authenticates with the per-session EXECUTOR token (kortix_pat_…, carries
      // the launching user's project/user id), never the bare sandbox token
      // (KORTIX_TOKEN, kortix_sb_…): the relay route only accepts an account
      // token that resolves to a projectId/userId (validateAccountToken).
      const executorToken = (env.KORTIX_EXECUTOR_TOKEN || env.KORTIX_CLI_TOKEN)?.trim()
      if (!apiUrl || !executorToken) {
        // Fail loudly instead of silently falling through to the generic
        // Kortix-managed-gateway default below — that silent fallback IS the
        // billing leak this branch exists to close, so it must never happen
        // for a subscription-authenticated session, missing credential or not.
        throw new Error(
          'Codex subscription auth requires KORTIX_API_URL and a session executor token ' +
            '(KORTIX_EXECUTOR_TOKEN/KORTIX_CLI_TOKEN); refusing to fall back to the ' +
            'Kortix-managed gateway key for a subscription-authenticated Pi session.',
        )
      }
      // The relay forwards this model id VERBATIM to the ChatGPT/Codex backend,
      // which only accepts codex-acp's own BARE advertised ids (gpt-5.6-sol,
      // gpt-5.5, …) — a gateway-style `openai/…`- or `codex/…`-prefixed id is
      // REJECTED (400). A caller-selected `runtimeModel` (fed from the same
      // advertised list the composer resolves via resolveHarnessModels) wins;
      // strip any `codex/` prefix defensively so a canonical-grammar id from
      // the composer still lands as a bare, backend-accepted value.
      const codexModel = (runtimeModel || 'gpt-5.6-sol').replace(/^codex\//, '')
      return {
        ...native,
        KORTIX_PI_MODELS_JSON: JSON.stringify({
          providers: {
            kortix: {
              baseUrl: `${apiUrl}/router/codex-subscription`,
              api: 'openai-responses',
              // Embedded literally (not a `$VAR` ref) so Pi sends
              // `Authorization: Bearer <executorToken>` to the relay, matching
              // the codex branch's DEFAULT_AUTH_REQUEST header. The relay
              // replaces this with the resolved Codex OAuth token server-side.
              apiKey: executorToken,
              authHeader: true,
              models: [
                {
                  id: codexModel,
                  name: codexModel,
                  reasoning: true,
                  input: ['text', 'image'],
                  contextWindow: 400000,
                  maxTokens: 128000,
                },
              ],
            },
          },
        }),
        PI_TELEMETRY: '0',
      }
    }
    if (custom?.protocol === 'openai') {
      return {
        ...native,
        KORTIX_PI_MODELS_JSON: JSON.stringify({
          providers: {
            custom: {
              baseUrl: custom.baseUrl,
              api: 'openai-responses',
              ...(custom.apiKey ? { apiKey: custom.apiKey } : {}),
              authHeader: Boolean(custom.apiKey),
              models: [
                {
                  id: runtimeModel || custom.model || 'default',
                  name: runtimeModel || custom.model || 'Default',
                  reasoning: true,
                  input: ['text', 'image'],
                  contextWindow: 128000,
                  maxTokens: 32768,
                },
              ],
            },
          },
        }),
        PI_TELEMETRY: '0',
      }
    }
    if (env.OPENAI_API_KEY || env.CODEX_API_KEY) {
      return {
        ...native,
        KORTIX_PI_MODELS_JSON: JSON.stringify({
          providers: {
            openai: {
              baseUrl: 'https://api.openai.com/v1',
              api: 'openai-responses',
              apiKey: env.OPENAI_API_KEY ? '$OPENAI_API_KEY' : '$CODEX_API_KEY',
              authHeader: true,
              models: [{
                id: runtimeModel || 'gpt-5.4',
                name: runtimeModel || 'GPT-5.4',
                reasoning: true,
                input: ['text', 'image'],
                contextWindow: 400000,
                maxTokens: 128000,
              }],
            },
          },
        }),
        PI_TELEMETRY: '0',
      }
    }
    if (!apiUrl || !token) return Object.keys(native).length ? native : undefined
    return {
      ...native,
      KORTIX_PI_MODELS_JSON: JSON.stringify({
        providers: {
          kortix: {
            baseUrl: `${apiUrl}/router/openai`,
            api: 'openai-responses',
            apiKey: '$KORTIX_TOKEN',
            authHeader: true,
            models: [
              {
                id: runtimeModel || 'gpt-5.4',
                name: runtimeModel || 'GPT-5.4',
                reasoning: true,
                input: ['text', 'image'],
                contextWindow: 400000,
                maxTokens: 128000,
              },
            ],
          },
        },
      }),
      PI_TELEMETRY: '0',
    }
  }
  if (id !== 'claude') return Object.keys(native).length ? native : undefined
  if (authKind === 'native_config') return Object.keys(native).length ? native : undefined
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
    const direct = {
      ...native,
      ...(runtimeModel ? { ANTHROPIC_MODEL: runtimeModel } : {}),
    }
    return Object.keys(direct).length ? direct : undefined
  }
  if (custom?.protocol === 'anthropic') {
    return {
      ...native,
      ANTHROPIC_BASE_URL: custom.baseUrl,
      ...(custom.apiKey ? { ANTHROPIC_AUTH_TOKEN: custom.apiKey } : {}),
      ...(runtimeModel || custom.model ? { ANTHROPIC_MODEL: runtimeModel || custom.model } : {}),
    }
  }
  if (!apiUrl || !token) return Object.keys(native).length ? native : undefined
  return {
    ...native,
    ANTHROPIC_BASE_URL: `${apiUrl}/router`,
    ANTHROPIC_AUTH_TOKEN: token,
    // Claude Code's release-channel default can be newer than the model exposed
    // by a compatible gateway. Pin the managed Kortix default so the harness
    // never scrapes a styled model name from CLI output or guesses a model the
    // account cannot use. A project-supplied Claude credential keeps native
    // Claude behavior and is intentionally not overridden above.
    ANTHROPIC_MODEL: runtimeModel || 'claude-sonnet-4-6',
  }
}

export function createAcpHarnessRegistry(env: NodeJS.ProcessEnv = process.env): AcpHarnessRegistry {
  return new Map(
    ACP_HARNESS_IDS.map((id) => {
      const defaults = DEFAULTS[id]
      const commandOverride = env[`${envPrefix(id)}_PATH`]?.trim()
      const descriptor: AcpHarnessDescriptor = {
        id,
        displayName: defaults.displayName,
        adapter: defaults.adapter,
        launch: {
          command: commandOverride || defaults.launch.command,
          args: argsFromEnv(id, commandOverride ? [] : defaults.launch.args, env),
          // Runtime credentials are synchronized after the daemon starts, so
          // this is only a diagnostic snapshot. AcpProcess resolves launch env
          // again from the latest merged project environment before spawning.
          env: resolveAcpHarnessLaunchEnv(id, isolateHarnessAuthEnv(env)),
        },
      }
      return [id, descriptor]
    }),
  )
}

export function parseAcpHarnessId(value: string | undefined | null): AcpHarnessId | null {
  const normalized = value?.trim().toLowerCase()
  return ACP_HARNESS_IDS.find((id) => id === normalized) ?? null
}
