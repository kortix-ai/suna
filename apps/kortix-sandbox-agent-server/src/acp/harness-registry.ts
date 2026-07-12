export const ACP_HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const

export type AcpHarnessId = (typeof ACP_HARNESS_IDS)[number]

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
  const raw = env.KORTIX_RUNTIME_CONFIG_DIR?.trim()
  if (!raw) return {}
  const workspace = env.KORTIX_WORKSPACE?.replace(/\/$/, '') || '/workspace'
  const dir = raw.startsWith('/') ? raw : `${workspace}/${raw.replace(/^\.\//, '')}`
  if (id === 'claude') return { CLAUDE_CONFIG_DIR: dir }
  if (id === 'codex') return { CODEX_HOME: dir }
  if (id === 'opencode') return { OPENCODE_CONFIG_DIR: dir }
  return { PI_CODING_AGENT_DIR: dir }
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
  const parsed: unknown = JSON.parse(raw)
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
  if (id === 'opencode') {
    const nativeAgent = env.KORTIX_NATIVE_AGENT?.trim()
    if (!nativeAgent && custom?.protocol !== 'openai') return Object.keys(native).length ? native : undefined
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
        ...(nativeAgent ? { default_agent: nativeAgent } : {}),
      }),
    }
  }
  if (id === 'codex') {
    // Direct API keys are consumed natively by codex-acp. Subscription auth is
    // intentionally different: CODEX_AUTH_JSON stays server-side where the
    // Kortix gateway can refresh it, and the adapter authenticates to that
    // gateway with the sandbox token below.
    if (env.CODEX_API_KEY || env.OPENAI_API_KEY) return Object.keys(native).length ? native : undefined
    if (custom?.protocol === 'openai') {
      return {
        ...native,
        NO_BROWSER: '1',
        ...(custom.model ? { CODEX_CONFIG: JSON.stringify({ model: custom.model }) } : {}),
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
      CODEX_CONFIG: JSON.stringify({ model: 'openai/gpt-5.4' }),
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
                  id: custom.model || 'default',
                  name: custom.model || 'Default',
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
                id: 'gpt-5.4',
                name: 'GPT-5.4',
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
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) return Object.keys(native).length ? native : undefined
  if (custom?.protocol === 'anthropic') {
    return {
      ...native,
      ANTHROPIC_BASE_URL: custom.baseUrl,
      ...(custom.apiKey ? { ANTHROPIC_AUTH_TOKEN: custom.apiKey } : {}),
      ...(custom.model ? { ANTHROPIC_MODEL: custom.model } : {}),
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
    ANTHROPIC_MODEL: 'claude-sonnet-4-6',
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
          env: resolveAcpHarnessLaunchEnv(id, env),
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
