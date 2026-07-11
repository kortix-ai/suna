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

function argsFromEnv(id: AcpHarnessId, fallback: string[], env: NodeJS.ProcessEnv): string[] {
  const raw = env[`${envPrefix(id)}_ARGS`]?.trim()
  if (!raw) return fallback
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${envPrefix(id)}_ARGS must be a JSON string array`)
  }
  return parsed
}

export function createAcpHarnessRegistry(
  env: NodeJS.ProcessEnv = process.env,
): AcpHarnessRegistry {
  return new Map(
    ACP_HARNESS_IDS.map((id) => {
      const defaults = DEFAULTS[id]
      const descriptor: AcpHarnessDescriptor = {
        id,
        displayName: defaults.displayName,
        adapter: defaults.adapter,
        launch: {
          command: env[`${envPrefix(id)}_PATH`]?.trim() || defaults.launch.command,
          args: argsFromEnv(id, defaults.launch.args, env),
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
