import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { access, constants, stat } from 'node:fs/promises'

import type { Config } from './config'
import { buildGitIdentityEnv } from './git'
import { logger } from './logger'
import { mergeProjectEnv, type ProjectEnvStore } from './project-env'

const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 20_000

// The Kortix Executor MCP server — the agent's primary interface to every
// configured connector (Pipedream / MCP / OpenAPI / GraphQL / HTTP). Baked into
// the sandbox image at this path (see apps/sandbox/Dockerfile).
const EXECUTOR_MCP_ENTRY = '/opt/kortix/apps/sandbox/agent-cli/connectors/executor-mcp.ts'
export const OPENCODE_HOME = '/opt/kortix/home'
export const OPENCODE_DATA_HOME = `${OPENCODE_HOME}/.local/share`
export const OPENCODE_CONFIG_HOME = `${OPENCODE_HOME}/.config`
export const OPENCODE_CACHE_HOME = `${OPENCODE_HOME}/.cache`
export const OPENCODE_AUTH_PATH = `${OPENCODE_DATA_HOME}/opencode/auth.json`
export const CODEX_AUTH_JSON_SECRET = 'CODEX_AUTH_JSON'
export const OPENCODE_AUTH_JSON_SECRET = 'OPENCODE_AUTH_JSON'

/**
 * Build the OPENCODE_CONFIG_CONTENT that registers the Executor as a local MCP
 * server so OpenCode loads it for every session — without the user's repo
 * carrying this sandbox-only wiring. Inline config merges ABOVE the project
 * config in OpenCode's precedence, so the server is always present.
 *
 * Returns undefined when the gateway is unreachable (no executor token / API
 * url) — we don't register a server that would just fail on startup. OpenCode's
 * inline config path skips `{env:}` substitution, so the resolved values are
 * embedded directly; they already match the sandbox env (OpenCode also forwards
 * its own env to MCP children, so this is belt-and-suspenders).
 */
export function buildExecutorMcpConfigContent(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.KORTIX_EXECUTOR_TOKEN
  const apiUrl = env.KORTIX_API_URL
  if (!token || !apiUrl) return undefined

  // Merge onto any pre-existing inline config rather than clobbering it.
  let base: Record<string, unknown> = {}
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
      // ignore malformed pre-existing content and start fresh
    }
  }
  const mcp =
    base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp)
      ? (base.mcp as Record<string, unknown>)
      : {}

  return JSON.stringify({
    ...base,
    mcp: {
      ...mcp,
      'kortix-executor': {
        type: 'local',
        command: ['bun', EXECUTOR_MCP_ENTRY],
        enabled: true,
        environment: {
          KORTIX_EXECUTOR_TOKEN: token,
          KORTIX_API_URL: apiUrl,
        },
      },
    },
  })
}

function materializeOpencodeAuth(env: NodeJS.ProcessEnv) {
  // Prefer the Codex-specific subscription secret. Keep OPENCODE_AUTH_JSON as a
  // legacy fallback so older projects keep working, but do not let subscription
  // onboarding clobber generic OpenCode auth settings.
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
  // Prefer the Kortix-patched binary when present in the snapshot.
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

/**
 * Coarse health state surfaced through `/kortix/health`.
 *   - `starting` — process supervisor is alive but opencode hasn't bound its
 *     internal port yet (binary missing, slow boot, between restarts).
 *   - `ok`       — last readiness probe succeeded.
 *   - `down`     — opencode has crashed / never spawned and we're not
 *     actively trying anymore (terminal supervisor stop).
 */
export type OpencodeState = 'starting' | 'ok' | 'down'

export type Opencode = {
  /** Begin supervision. Never throws — failures degrade to `state === 'starting'`. */
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  getPid(): number | null
  getInternalUrl(): string
  getBinaryPath(): string | null
  getState(): OpencodeState
}

/**
 * OpenCode child process supervisor.
 * - Spawns `opencode serve --port <internal> --hostname 127.0.0.1` in the
 *   cloned project directory when it exists.
 * - Restarts on crash with exponential backoff up to 30s.
 * - Background readiness loop flips state ok/starting based on `/app` probes.
 * - `start()` is non-fatal: if the binary is missing or the child won't bind,
 *   the daemon stays up and reports `opencode: 'starting'` (or `down` after stop).
 */
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
    // Daytona can delete /workspace after our entrypoint exits — re-mkdir
    // on every spawn attempt. If recreation fails (extremely rare), fall
    // back to / so spawn at least gets a valid working directory.
    try {
      mkdirSync(opencodeCwd, { recursive: true })
      return opencodeCwd
    } catch (err) {
      logger.warn('[opencode] could not mkdir cwd, falling back to /', { opencodeCwd, err: (err as Error).message })
      return '/'
    }
  }

  // Bun-compiled binaries (opencode itself) extract a ~4.7MB runtime blob to
  // $TMPDIR as `.<hash>-00000000.so` on every launch and never clean it up. With
  // a supervisor that restarts opencode on crash, these pile up fast — a tight
  // restart loop leaked ~700 files (~3GB) and filled the sandbox's small disk,
  // after which EVERY write fails with ENOSPC. opencode then reports the generic
  // "Failed to write auth data" on login, masking the real cause. Sweep the
  // stale extractions before each (re)spawn so /tmp can't run away. Best-effort.
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
    // Keep opencode's data store OUT of the project workspace. opencode writes
    // a git-backed snapshot object store (file history) plus caches/logs under
    // $HOME/.local/share/opencode + $HOME/.config. If HOME points at
    // /workspace, that store lands inside the project dir and grows one loose
    // object per file version — so every ls/glob/list the agent runs walks
    // thousands of .local/share/opencode/snapshot/objects/* paths, ballooning
    // tool output (multi-MB) until the next turn stalls. A dedicated home keeps
    // /workspace = project files only. OPENCODE_CONFIG_DIR still points at the
    // project's .kortix/opencode so user config/agents/skills load normally.
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
      // Clear inherited PORT/APP_PORT — opencode launches user shells; we
      // don't want to leak the service port as a generic app port.
      PORT: undefined,
      APP_PORT: undefined,
    }

    materializeOpencodeAuth(env)

    // Register the Kortix Executor MCP server so the agent reaches every
    // configured connector as native MCP tools — the primary interface in the
    // sandbox. No-op when the executor gateway isn't wired for this session.
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

  async function checkReady(): Promise<boolean> {
    // A bound HTTP server is not enough. When the project workspace is
    // missing or OpenCode inherited a bad cwd, /global/health can still
    // return 200 while every real OpenCode API route returns 500. Probe the
    // same session API the app needs before reporting `opencode: ok`.
    try {
      const directory = encodeURIComponent(cfg.projectTarget)
      const res = await fetch(`http://127.0.0.1:${cfg.opencodeInternalPort}/session?directory=${directory}`, {
        signal: AbortSignal.timeout(2_000),
      })
      return res.status >= 200 && res.status < 400
    } catch {
      return false
    }
  }

  function scheduleReadinessProbe() {
    if (stopping) return
    readinessTimer = setTimeout(async () => {
      if (stopping) return
      const ready = await checkReady()
      if (ready) {
        if (state !== 'ok') logger.info('[opencode] ready')
        state = 'ok'
        restartDelayMs = 500
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
  }
}

/**
 * Tail-readiness probe used at boot to deadline-bound the first ready state.
 * Returns true if opencode reported ready before the deadline, false otherwise.
 * Non-throwing — the daemon should boot even on false so we can report `starting`.
 */
export async function waitForOpencodeReady(opencode: Opencode): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (opencode.getState() === 'ok') return true
    await new Promise((r) => setTimeout(r, READY_POLL_MS))
  }
  return false
}
