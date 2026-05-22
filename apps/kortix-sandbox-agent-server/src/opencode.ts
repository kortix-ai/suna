import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { access, constants, stat } from 'node:fs/promises'

import type { Config } from './config'
import { logger } from './logger'

const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 20_000

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
export function createOpencodeSupervisor(cfg: Config, opencodeConfigDir: string): Opencode {
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

  function spawnChild(bin: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: cfg.workspace,
      OPENCODE_CONFIG_DIR: opencodeConfigDir,
      // Clear inherited PORT/APP_PORT — opencode launches user shells; we
      // don't want to leak the service port as a generic app port.
      PORT: undefined,
      APP_PORT: undefined,
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
