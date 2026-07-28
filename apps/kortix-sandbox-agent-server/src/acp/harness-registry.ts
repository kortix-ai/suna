import { join } from 'node:path'

export const ACP_HARNESS_IDS = [
  'claude',
  'codex',
  'opencode',
  'pi',
] as const

export type AcpHarnessId = (typeof ACP_HARNESS_IDS)[number]

export type AcpHarnessLaunch = {
  command: string
  args: string[]
}

export type AcpHarnessDescriptor = {
  id: AcpHarnessId
  displayName: string
  adapter: string
  launch: AcpHarnessLaunch
}

export type AcpHarnessRegistry = ReadonlyMap<
  AcpHarnessId,
  AcpHarnessDescriptor
>

const DEFAULTS: Record<
  AcpHarnessId,
  Omit<AcpHarnessDescriptor, 'id'>
> = {
  claude: {
    displayName: 'Claude Code',
    adapter: '@agentclientprotocol/claude-agent-acp',
    launch: { command: 'claude-agent-acp', args: [] },
  },
  codex: {
    displayName: 'Codex',
    adapter: '@agentclientprotocol/codex-acp',
    launch: { command: 'codex-acp', args: [] },
  },
  opencode: {
    displayName: 'OpenCode',
    adapter: 'native',
    launch: { command: 'opencode', args: ['acp'] },
  },
  pi: {
    displayName: 'Pi',
    adapter: 'pi-acp',
    launch: { command: 'pi-acp', args: [] },
  },
}

function envPrefix(id: AcpHarnessId): string {
  return `KORTIX_ACP_${id.toUpperCase()}`
}

function argsFromEnv(
  id: AcpHarnessId,
  fallback: string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const name = `${envPrefix(id)}_ARGS`
  const raw = env[name]?.trim()
  if (!raw) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name} must be a JSON string array`)
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${name} must be a JSON string array`)
  }
  return parsed
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || '/home/kortix'
}

function runtimeConfigDir(
  id: AcpHarnessId,
  env: NodeJS.ProcessEnv,
): string {
  const configured = env.KORTIX_RUNTIME_CONFIG_DIR?.trim()
  if (configured) {
    if (configured.startsWith('/')) return configured
    const workspace =
      env.KORTIX_WORKSPACE?.replace(/\/$/, '') || '/workspace'
    return `${workspace}/${configured.replace(/^\.\//, '')}`
  }

  const home = homeDir(env)
  if (id === 'claude') return join(home, '.claude')
  if (id === 'codex') return join(home, '.codex')
  if (id === 'opencode') {
    return (
      env.OPENCODE_CONFIG_DIR?.trim() ||
      join(home, '.config', 'opencode')
    )
  }
  return join(home, '.pi', 'agent')
}

function nativeConfigEnv(
  id: AcpHarnessId,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const dir = runtimeConfigDir(id, env)
  if (id === 'claude') return { CLAUDE_CONFIG_DIR: dir }
  if (id === 'codex') return { CODEX_HOME: dir }
  if (id === 'opencode') return { OPENCODE_CONFIG_DIR: dir }
  return { PI_CODING_AGENT_DIR: dir }
}

function managedGateway(
  env: NodeJS.ProcessEnv,
): { apiUrl: string; token: string } | null {
  const apiUrl = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  const token = (
    env.KORTIX_SANDBOX_TOKEN || env.KORTIX_TOKEN
  )?.trim()
  return apiUrl && token ? { apiUrl, token } : null
}

export function resolveAcpHarnessLaunchEnv(
  id: AcpHarnessId,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const native = nativeConfigEnv(id, env)
  const gateway = managedGateway(env)

  if (id === 'opencode') return native

  if (id === 'claude') {
    const direct =
      env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN ||
      env.CLAUDE_CODE_OAUTH_TOKEN
    if (direct || !gateway) {
      return {
        ...native,
        IS_SANDBOX: '1',
      }
    }
    return {
      ...native,
      IS_SANDBOX: '1',
      ANTHROPIC_BASE_URL: `${gateway.apiUrl}/router`,
      ANTHROPIC_AUTH_TOKEN: gateway.token,
      ANTHROPIC_MODEL:
        env.KORTIX_RUNTIME_MODEL?.trim() || 'claude-sonnet-4-6',
    }
  }

  if (id === 'codex') {
    if (env.CODEX_API_KEY || env.OPENAI_API_KEY) {
      return {
        ...native,
        NO_BROWSER: '1',
        DEFAULT_AUTH_REQUEST: JSON.stringify({
          methodId: 'api-key',
        }),
      }
    }
    if (!gateway) {
      return {
        ...native,
        NO_BROWSER: '1',
      }
    }
    return {
      ...native,
      NO_BROWSER: '1',
      CODEX_CONFIG: JSON.stringify({
        model:
          env.KORTIX_RUNTIME_MODEL?.trim() || 'openai/gpt-5.4',
      }),
      DEFAULT_AUTH_REQUEST: JSON.stringify({
        methodId: 'gateway',
        _meta: {
          gateway: {
            baseUrl: `${gateway.apiUrl}/router/openai`,
            providerName: 'Kortix Gateway',
            headers: {
              Authorization: `Bearer ${gateway.token}`,
            },
          },
        },
      }),
    }
  }

  const directOpenAiKey = env.OPENAI_API_KEY || env.CODEX_API_KEY
  if (directOpenAiKey) {
    const model = env.KORTIX_RUNTIME_MODEL?.trim() || 'gpt-5.4'
    return {
      ...native,
      PI_TELEMETRY: '0',
      KORTIX_PI_MODELS_JSON: JSON.stringify({
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            apiKey: env.OPENAI_API_KEY
              ? '$OPENAI_API_KEY'
              : '$CODEX_API_KEY',
            authHeader: true,
            models: [
              {
                id: model,
                name: model,
                reasoning: true,
                input: ['text', 'image'],
                contextWindow: 400000,
                maxTokens: 128000,
              },
            ],
          },
        },
      }),
    }
  }

  if (!gateway) {
    return {
      ...native,
      PI_TELEMETRY: '0',
    }
  }
  const model = env.KORTIX_RUNTIME_MODEL?.trim() || 'gpt-5.4'
  const tokenReference = env.KORTIX_SANDBOX_TOKEN
    ? '$KORTIX_SANDBOX_TOKEN'
    : '$KORTIX_TOKEN'
  return {
    ...native,
    PI_TELEMETRY: '0',
    KORTIX_PI_MODELS_JSON: JSON.stringify({
      providers: {
        kortix: {
          baseUrl: `${gateway.apiUrl}/router/openai`,
          api: 'openai-responses',
          apiKey: tokenReference,
          authHeader: true,
          models: [
            {
              id: model,
              name: model,
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 400000,
              maxTokens: 128000,
            },
          ],
        },
      },
    }),
  }
}

export function createAcpHarnessRegistry(
  env: NodeJS.ProcessEnv = process.env,
): AcpHarnessRegistry {
  return new Map(
    ACP_HARNESS_IDS.map((id) => {
      const defaults = DEFAULTS[id]
      const commandOverride = env[`${envPrefix(id)}_PATH`]?.trim()
      return [
        id,
        {
          id,
          displayName: defaults.displayName,
          adapter: defaults.adapter,
          launch: {
            command: commandOverride || defaults.launch.command,
            args: argsFromEnv(
              id,
              commandOverride ? [] : defaults.launch.args,
              env,
            ),
          },
        },
      ]
    }),
  )
}

export function parseAcpHarnessId(
  value: string | undefined | null,
): AcpHarnessId | null {
  const normalized = value?.trim().toLowerCase()
  return (
    ACP_HARNESS_IDS.find((id) => id === normalized) ?? null
  )
}
