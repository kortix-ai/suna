import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { access, constants, stat } from 'node:fs/promises'

import { AGENT_ENV_SH } from './agent-env-file'
import type { Config } from './config'
import { buildGitIdentityEnv } from './git'
import { logger } from './logger'
import { mergeProjectEnv, type ProjectEnvStore } from './project-env'

const READY_POLL_MS = 100
const BOOT_READY_POLL_MS = 50
const READY_TIMEOUT_MS = 20_000
// Once opencode is READY, the readiness probe becomes a slow LIVENESS check.
// Polling /session every READY_POLL_MS (100ms) forever pegged opencode's Bun
// event loop at ~55% of a CPU core PER IDLE SANDBOX (load-tested 2026-06-16) —
// the dominant cap on warm-sandbox density (~14/host). A crash is already caught
// by proc.on('exit'); after ready we only need an occasional liveness ping, so
// drop to a 5s interval (~50x fewer probes → idle opencode falls to ~2% of a core).
const READY_LIVENESS_MS = 5_000

export const OPENCODE_HOME = '/opt/kortix/home'
const OPENCODE_DATA_HOME = `${OPENCODE_HOME}/.local/share`
const OPENCODE_CONFIG_HOME = `${OPENCODE_HOME}/.config`
const OPENCODE_CACHE_HOME = `${OPENCODE_HOME}/.cache`
const OPENCODE_AUTH_PATH = `${OPENCODE_DATA_HOME}/opencode/auth.json`
const CODEX_AUTH_JSON_SECRET = 'CODEX_AUTH_JSON'
const OPENCODE_AUTH_JSON_SECRET = 'OPENCODE_AUTH_JSON'

// Assemble the inline opencode config (OPENCODE_CONFIG_CONTENT) the daemon hands
// opencode at spawn. It MERGES over the repo's own opencode config and has three
// independent contributors, any of which may apply:
//   1. the Kortix Executor MCP server   (when KORTIX_EXECUTOR_TOKEN + API url)
//   2. the Kortix LLM gateway provider  (when KORTIX_LLM_* env)
//   3. a Slack permission override      (when this is a Slack session)
// If NONE apply there's nothing to inject, so we return undefined and opencode
// just uses the repo config as-is.
export async function buildOpencodeConfigContent(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const executorToken = env.KORTIX_EXECUTOR_TOKEN
  const apiUrl = env.KORTIX_API_URL
  const llmBaseUrl = env.KORTIX_LLM_BASE_URL
  const llmApiKey = env.KORTIX_LLM_API_KEY

  const hasExecutor = !!executorToken && !!apiUrl
  const hasLlmGateway = !!llmBaseUrl && !!llmApiKey
  // A Slack-provisioned session carries SLACK_CHANNEL_ID / SLACK_THREAD_TS (the
  // session identity the API hands us at boot; also what the in-sandbox `slack`
  // CLI uses to post back to the thread). Contributor #3 keys off it.
  const isSlackSession = !!(env.SLACK_THREAD_TS || env.SLACK_CHANNEL_ID)
  if (!hasExecutor && !hasLlmGateway && !isSlackSession) return undefined

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

  // (1) Kortix Executor MCP server.
  if (hasExecutor) {
    const mcp =
      out.mcp && typeof out.mcp === 'object' && !Array.isArray(out.mcp)
        ? (out.mcp as Record<string, unknown>)
        : {}
    out.mcp = {
      ...mcp,
      'kortix-executor': {
        type: 'local',
        // The Executor MCP server is a face of the unified `kortix` CLI
        // (`kortix executor mcp`), baked onto PATH in every sandbox image.
        command: ['kortix', 'executor', 'mcp'],
        enabled: true,
        environment: {
          KORTIX_EXECUTOR_TOKEN: executorToken,
          KORTIX_API_URL: apiUrl,
          // Lets the CLI target the project-explicit gateway route. Optional —
          // the session token also pins the project for the legacy flat route,
          // so this is belt-and-suspenders.
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
    out.provider = {
      ...provider,
      kortix: await buildKortixProvider(llmBaseUrl!, llmApiKey!),
    }
    if (!('model' in out) || typeof out.model !== 'string') {
      out.model = DEFAULT_KORTIX_MODEL
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

  return JSON.stringify(out)
}

async function buildKortixProvider(llmBaseUrl: string, llmApiKey: string): Promise<Record<string, unknown>> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Kortix',
    options: {
      baseURL: llmBaseUrl,
      apiKey: llmApiKey,
    },
    models: withModelLimits(await fetchGatewayModels(llmBaseUrl, llmApiKey)),
  }
}

export const buildExecutorMcpConfigContent = buildOpencodeConfigContent

const GATEWAY_MODELS_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

async function fetchGatewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, KortixGatewayModel>> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const attempts = GATEWAY_MODELS_RETRY_DELAYS_MS.length + 1
  logger.info(`[opencode] fetching gateway models from ${url}`)
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } })
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
      logger.warn(
        `[opencode] gateway models fetch failed (attempt ${attempt + 1}/${attempts}) ${url}: ${(err as Error).message}`,
      )
      const delay = GATEWAY_MODELS_RETRY_DELAYS_MS[attempt]
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  logger.error(`[opencode] gateway models unavailable after ${attempts} attempts (${url}); using minimal fallback`)
  return MINIMAL_FALLBACK_MODELS
}

const DEFAULT_KORTIX_MODEL = 'kortix/kortix-power'

type KortixGatewayModel = {
  name: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  limit?: { context?: number; output?: number }
}

const MINIMAL_FALLBACK_MODELS: Record<string, KortixGatewayModel> = {
  'kortix-power': {
    name: 'Kortix Power',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  'kortix-basic': {
    name: 'Kortix Basic',
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
    const fallback = known ?? DEFAULT_MODEL_LIMIT
    out[id] = {
      ...model,
      limit: {
        context: fallback.context ?? DEFAULT_MODEL_LIMIT.context,
        output:
          typeof model.limit?.output === 'number' && model.limit.output > 0
            ? model.limit.output
            : (fallback.output ?? DEFAULT_MODEL_LIMIT.output),
      },
    }
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

type OpencodeState = 'starting' | 'ok' | 'down'

export type Opencode = {
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  reconfigure(nextCfg: Config, nextOpencodeConfigDir: string, nextProjectEnv?: ProjectEnvStore): void
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
  let currentCfg = cfg
  let currentOpencodeConfigDir = opencodeConfigDir
  let currentProjectEnv = projectEnv
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

  async function spawnChild(bin: string) {
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
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...buildGitIdentityEnv(currentCfg),
      HOME: OPENCODE_HOME,
      XDG_DATA_HOME: OPENCODE_DATA_HOME,
      XDG_CONFIG_HOME: OPENCODE_CONFIG_HOME,
      XDG_CACHE_HOME: OPENCODE_CACHE_HOME,
      OPENCODE_CONFIG_DIR: currentOpencodeConfigDir,
      // Every non-interactive shell opencode spawns (`bash -c`) sources this,
      // so live project secrets reach the agent's commands without any
      // opencode plugin/config. Interactive shells + terminals get it from the
      // image-baked /etc/profile.d + /etc/bash.bashrc hooks instead.
      BASH_ENV: AGENT_ENV_SH,
      PORT: undefined,
      APP_PORT: undefined,
    }

    materializeOpencodeAuth(env)

    // Withhold provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) from the
    // opencode process. With any such key in its env, opencode auto-connects a
    // NATIVE provider and calls it directly — bypassing the gateway (no logs /
    // spend / budgets) and leaving stale models that survive a BYOK disconnect.
    // The gateway must be the only LLM path, so the API hands us the exact names
    // to strip (Codex/OpenCode subscription auth is excluded — it's already been
    // consumed into auth.json by materializeOpencodeAuth above). This only touches
    // the opencode process env; it doesn't change what the container itself holds.
    const denyEnv = (env.KORTIX_OPENCODE_DENY_ENV || '').split(',').map((n) => n.trim()).filter(Boolean)
    let withheld = 0
    for (const name of denyEnv) {
      if (name in env) {
        delete env[name]
        withheld++
      }
    }
    if (withheld > 0) {
      logger.info(`[opencode] withheld ${withheld} provider credential(s) from opencode (gateway-only routing)`)
    }

    // Boot profiling: when KORTIX_OPENCODE_DEBUG=1, ask opencode to emit its own
    // verbose startup logs (interleaved into the daemon log via inherited
    // stdio) so a real cold boot reveals where the spawn→ready window goes.
    // Opt-in only — no log noise in normal operation.
    if (process.env.KORTIX_OPENCODE_DEBUG === '1') {
      env.OPENCODE_LOG_LEVEL = 'DEBUG'
    }

    const opencodeConfig = await buildOpencodeConfigContent(baseEnv)
    if (opencodeConfig) {
      // The assembled config carries the gateway's full model catalog, which is
      // ~400KB — far over Linux's 128KB per-env-var ceiling (MAX_ARG_STRLEN).
      // Inlining it via OPENCODE_CONFIG_CONTENT makes execve fail with E2BIG and
      // opencode never spawns ("runtime not ready"). Hand it a file path instead.
      const configPath = join(OPENCODE_CONFIG_HOME, 'kortix-opencode.json')
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, opencodeConfig, { mode: 0o600 })
      env.OPENCODE_CONFIG = configPath
      delete env.OPENCODE_CONFIG_CONTENT
      logger.info(`[opencode] wrote config (${opencodeConfig.length} bytes) to ${configPath}`)
    }

    const args = [
      'serve',
      '--port',
      String(currentCfg.opencodeInternalPort),
      '--hostname',
      '127.0.0.1',
    ]

    const cwd = ensureCwdExists()
    logger.info('[opencode] spawning', { bin, port: currentCfg.opencodeInternalPort, cwd })
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
        if (!stopping && binaryPath) void spawnChild(binaryPath)
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
    return probeOpencodeSessionApi(`http://127.0.0.1:${currentCfg.opencodeInternalPort}`, currentCfg.projectTarget, 2_000)
  }

  function scheduleReadinessProbe() {
    if (stopping) return
    // Poll fast until ready (quick boot detection), then slow to a liveness ping.
    // The forever-100ms poll cost ~55% of a core per idle sandbox (READY_LIVENESS_MS).
    const interval = state === 'ok' ? READY_LIVENESS_MS : READY_POLL_MS
    readinessTimer = setTimeout(async () => {
      if (stopping) return
      const ready = await checkReady()
      if (ready) {
        markReady()
      } else if (state !== 'starting') {
        state = 'starting'
      }
      scheduleReadinessProbe()
    }, interval)
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
      opencodeCwd = await resolveOpencodeCwd(currentCfg)
      try {
        await spawnChild(bin)
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

    reconfigure(nextCfg: Config, nextOpencodeConfigDir: string, nextProjectEnv?: ProjectEnvStore) {
      currentCfg = nextCfg
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

    getInternalUrl() {
      return `http://127.0.0.1:${currentCfg.opencodeInternalPort}`
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
