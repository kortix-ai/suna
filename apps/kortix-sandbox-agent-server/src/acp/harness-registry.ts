import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const dir = nativeConfigDir(env)
  if (!dir) return {}
  if (id === 'claude') return { CLAUDE_CONFIG_DIR: dir }
  if (id === 'codex') return { CODEX_HOME: dir }
  if (id === 'opencode') return { OPENCODE_CONFIG_DIR: dir }
  return { PI_CODING_AGENT_DIR: dir }
}

export function nativeConfigDir(env: NodeJS.ProcessEnv): string | null {
  const raw = env.KORTIX_RUNTIME_CONFIG_DIR?.trim()
  if (!raw) return null
  const workspace = env.KORTIX_WORKSPACE?.replace(/\/$/, '') || '/workspace'
  return raw.startsWith('/') ? raw : `${workspace}/${raw.replace(/^\.\//, '')}`
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
  const native = nativeConfigEnv(id, env)
  const apiUrl = env.KORTIX_API_URL?.replace(/\/$/, '')
  const token = env.KORTIX_TOKEN?.trim()
  const custom = customProvider(env)
  const runtimeModel = env.KORTIX_RUNTIME_MODEL?.trim()
  const authKind = runtimeAuthKind(env)
  if (id === 'opencode') {
    const nativeAgent = env.KORTIX_NATIVE_AGENT?.trim()
    if (!nativeAgent && !runtimeModel && custom?.protocol !== 'openai') return Object.keys(native).length ? native : undefined
    let existing: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
    } catch {
      // A malformed inherited override must not make logical agent routing
      // disappear. OpenCode receives the manifest-selected default below.
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
    return {
      ...native,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...existing,
        ...customConfig,
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
    // Direct API keys are consumed natively by codex-acp. Subscription auth is
    // intentionally different: CODEX_AUTH_JSON stays server-side where the
    // Kortix gateway can refresh it, and the adapter authenticates to that
    // gateway with the sandbox token below.
    if (authKind === 'native_config') {
      const direct = {
        ...native,
        ...(Object.keys(profileConfig).length ? { CODEX_CONFIG: JSON.stringify(profileConfig) } : {}),
      }
      return Object.keys(direct).length ? direct : undefined
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
    if (authKind === 'native_config') return Object.keys(native).length ? native : undefined
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
