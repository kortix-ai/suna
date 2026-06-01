import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { access, constants, stat } from 'node:fs/promises'

import type { Config } from './config'
import { buildGitIdentityEnv } from './git'
import { logger } from './logger'
import { mergeProjectEnv, type ProjectEnvStore } from './project-env'

const READY_POLL_MS = 100
const BOOT_READY_POLL_MS = 50
const READY_TIMEOUT_MS = 20_000

const EXECUTOR_MCP_ENTRY = '/opt/kortix/apps/sandbox/agent-cli/connectors/executor-mcp.ts'
export const OPENCODE_HOME = '/opt/kortix/home'
export const OPENCODE_DATA_HOME = `${OPENCODE_HOME}/.local/share`
export const OPENCODE_CONFIG_HOME = `${OPENCODE_HOME}/.config`
export const OPENCODE_CACHE_HOME = `${OPENCODE_HOME}/.cache`
export const OPENCODE_AUTH_PATH = `${OPENCODE_DATA_HOME}/opencode/auth.json`
export const CODEX_AUTH_JSON_SECRET = 'CODEX_AUTH_JSON'
export const OPENCODE_AUTH_JSON_SECRET = 'OPENCODE_AUTH_JSON'

export function buildExecutorMcpConfigContent(env: NodeJS.ProcessEnv): string | undefined {
  const executorToken = env.KORTIX_EXECUTOR_TOKEN
  const apiUrl = env.KORTIX_API_URL
  const llmBaseUrl = env.KORTIX_LLM_BASE_URL
  const llmApiKey = env.KORTIX_LLM_API_KEY

  const hasExecutor = !!executorToken && !!apiUrl
  const hasLlmGateway = !!llmBaseUrl && !!llmApiKey
  if (!hasExecutor && !hasLlmGateway) return undefined

  let base: Record<string, unknown> = {}
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
    }
  }
  const out: Record<string, unknown> = { ...base }

  if (hasExecutor) {
    const mcp =
      out.mcp && typeof out.mcp === 'object' && !Array.isArray(out.mcp)
        ? (out.mcp as Record<string, unknown>)
        : {}
    out.mcp = {
      ...mcp,
      'kortix-executor': {
        type: 'local',
        command: ['bun', EXECUTOR_MCP_ENTRY],
        enabled: true,
        environment: {
          KORTIX_EXECUTOR_TOKEN: executorToken,
          KORTIX_API_URL: apiUrl,
        },
      },
    }
  }

  if (hasLlmGateway) {
    const provider =
      out.provider && typeof out.provider === 'object' && !Array.isArray(out.provider)
        ? (out.provider as Record<string, unknown>)
        : {}
    out.provider = {
      ...provider,
      kortix: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kortix',
        options: {
          baseURL: llmBaseUrl,
          apiKey: llmApiKey,
        },
        models: KORTIX_GATEWAY_MODELS,
      },
    }
    if (!('model' in out) || typeof out.model !== 'string') {
      out.model = DEFAULT_KORTIX_MODEL
    }
  }

  return JSON.stringify(out)
}

const DEFAULT_KORTIX_MODEL = 'kortix/anthropic/claude-opus-4.8'

type KortixGatewayModel = {
  name: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  limit?: { context?: number; output?: number }
}

const KORTIX_GATEWAY_MODELS: Record<string, KortixGatewayModel> = {
  'anthropic/claude-opus-4.8': {
    name: 'Claude Opus 4.8',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  'anthropic/claude-sonnet-4.6': {
    name: 'Claude Sonnet 4.6',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  'openai/gpt-5.5': {
    name: 'GPT-5.5',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 64_000 },
  },
  'google/gemini-3.5-flash': {
    name: 'Gemini 3.5 Flash',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'google/gemini-3.1-pro-preview': {
    name: 'Gemini 3.1 Pro',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'deepseek/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'deepseek/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'minimax/minimax-m3': {
    name: 'MiniMax M3',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'moonshotai/kimi-k2.6': {
    name: 'Kimi K2.6',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 262_144, output: 64_000 },
  },
  'z-ai/glm-5.1': {
    name: 'GLM 5.1',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 202_752, output: 64_000 },
  },
  'x-ai/grok-4.3': {
    name: 'Grok 4.3',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
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

async function detectOpencodeBinary(): Promise<string | null> {
  if (await isExecutable('/usr/local/bin/opencode-kortix')) {
    return '/usr/local/bin/opencode-kortix'
  }
  return await which('opencode')
}

async function resolveOpencodeCwd(cfg: Config): Promise<string> {
  try {
    const project = await stat(cfg.projectTarget)
    if (project.isDirectory()) return cfg.projectTarget
  } catch {}
  return cfg.workspace
}

export type OpencodeState = 'starting' | 'ok' | 'down'

export type Opencode = {
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  getPid(): number | null
  getInternalUrl(): string
  getBinaryPath(): string | null
  getState(): OpencodeState
  markReady(): void
}

export function createOpencodeSupervisor(
  cfg: Config,
  opencodeConfigDir: string,
  projectEnv?: ProjectEnvStore,
): Opencode {
  let child: ChildProcess | null = null
  let binaryPath: string | null = null
  let stopping = false
  let restartDelayMs = 500
  let state: OpencodeState = 'starting'
  let readinessTimer: ReturnType<typeof setTimeout> | null = null
  let opencodeCwd = cfg.workspace

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

  function spawnChild(bin: string) {
    sweepBunExtractions()
    try {
      mkdirSync(OPENCODE_HOME, { recursive: true })
    } catch (err) {
      logger.warn('[opencode] could not create home dir; falling back to inherited HOME', {
        opencodeHome: OPENCODE_HOME,
        err: (err as Error).message,
      })
    }
    const baseEnv = projectEnv ? mergeProjectEnv(process.env, projectEnv) : process.env
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...buildGitIdentityEnv(cfg),
      HOME: OPENCODE_HOME,
      XDG_DATA_HOME: OPENCODE_DATA_HOME,
      XDG_CONFIG_HOME: OPENCODE_CONFIG_HOME,
      XDG_CACHE_HOME: OPENCODE_CACHE_HOME,
      OPENCODE_CONFIG_DIR: opencodeConfigDir,
      PORT: undefined,
      APP_PORT: undefined,
    }

    materializeOpencodeAuth(env)

    const executorConfig = buildExecutorMcpConfigContent(baseEnv)
    if (executorConfig) {
      env.OPENCODE_CONFIG_CONTENT = executorConfig
      logger.info('[opencode] registered kortix-executor MCP server')
    }

    const args = [
      'serve',
      '--port',
      String(cfg.opencodeInternalPort),
      '--hostname',
      '127.0.0.1',
    ]

    const cwd = ensureCwdExists()
    logger.info('[opencode] spawning', { bin, port: cfg.opencodeInternalPort, cwd })
    const proc = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    })

    proc.on('exit', (code, signal) => {
      logger.warn('[opencode] child exited', { code, signal })
      child = null
      state = stopping ? 'down' : 'starting'
      if (stopping) return
      const delay = restartDelayMs
      restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
      logger.info('[opencode] restarting', { delayMs: delay })
      setTimeout(() => {
        if (!stopping && binaryPath) spawnChild(binaryPath)
      }, delay)
    })

    proc.on('error', (err) => {
      logger.error('[opencode] spawn error', err)
    })

    child = proc
  }

  function markReady() {
    if (state !== 'ok') logger.info('[opencode] ready')
    state = 'ok'
    restartDelayMs = 500
  }

  async function checkReady(): Promise<boolean> {
    return probeOpencodeSessionApi(`http://127.0.0.1:${cfg.opencodeInternalPort}`, cfg.projectTarget, 2_000)
  }

  function scheduleReadinessProbe() {
    if (stopping) return
    readinessTimer = setTimeout(async () => {
      if (stopping) return
      const ready = await checkReady()
      if (ready) {
        markReady()
      } else if (state !== 'starting') {
        state = 'starting'
      }
      scheduleReadinessProbe()
    }, READY_POLL_MS)
  }

  return {
    async start() {
      stopping = false
      state = 'starting'
      const bin = await detectOpencodeBinary()
      if (!bin) {
        logger.warn('[opencode] binary not found on PATH (and /usr/local/bin/opencode-kortix missing); daemon will continue, opencode reports as starting')
        state = 'starting'
        scheduleReadinessProbe()
        return
      }
      binaryPath = bin
      opencodeCwd = await resolveOpencodeCwd(cfg)
      try {
        spawnChild(bin)
      } catch (err) {
        logger.error('[opencode] initial spawn failed', err)
      }
      scheduleReadinessProbe()
    },

    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      stopping = true
      state = 'down'
      if (readinessTimer) {
        clearTimeout(readinessTimer)
        readinessTimer = null
      }
      if (!child) return
      const c = child
      return new Promise<void>((resolve) => {
        const onExit = () => resolve()
        c.once('exit', onExit)
        try {
          c.kill(signal)
        } catch {
          resolve()
          return
        }
        // Hard kill if the child ignores SIGTERM.
        setTimeout(() => {
          try {
            c.kill('SIGKILL')
          } catch {}
          resolve()
        }, 5_000).unref()
      })
    },

    async restart() {
      await this.stop('SIGTERM')
      restartDelayMs = 500
      await this.start()
    },

    getPid() {
      return child?.pid ?? null
    },

    getInternalUrl() {
      return `http://127.0.0.1:${cfg.opencodeInternalPort}`
    },

    getBinaryPath() {
      return binaryPath
    },

    getState() {
      return state
    },

    markReady,
  }
}

/**
 * Probe the same OpenCode API the app needs. A plain process/HTTP health route
 * is too weak because OpenCode can bind while the project directory is still
 * unusable for real session APIs.
 */
export async function probeOpencodeSessionApi(
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
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (opencode.getState() === 'ok') return true
    if (directory && await probeOpencodeSessionApi(opencode.getInternalUrl(), directory, 500)) {
      opencode.markReady()
      return true
    }
    await new Promise((r) => setTimeout(r, directory ? BOOT_READY_POLL_MS : READY_POLL_MS))
  }
  return false
}
