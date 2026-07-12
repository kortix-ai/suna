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

function argsFromEnv(id: AcpHarnessId, fallback: string[], env: NodeJS.ProcessEnv): string[] {
  const raw = env[`${envPrefix(id)}_ARGS`]?.trim()
  if (!raw) return fallback
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${envPrefix(id)}_ARGS must be a JSON string array`)
  }
  return parsed
}

function defaultLaunchEnv(id: AcpHarnessId, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const apiUrl = env.KORTIX_API_URL?.replace(/\/$/, '')
  const token = env.KORTIX_TOKEN?.trim()
  if (id === 'codex') {
    if (env.CODEX_API_KEY || env.OPENAI_API_KEY || env.CODEX_AUTH_JSON) return undefined
    if (!apiUrl || !token) return undefined
    return {
      NO_BROWSER: '1',
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
  if (id !== 'claude' || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return undefined
  if (!apiUrl || !token) return undefined
  return {
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

export function createAcpHarnessRegistry(
  env: NodeJS.ProcessEnv = process.env,
): AcpHarnessRegistry {
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
          env: defaultLaunchEnv(id, env),
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
