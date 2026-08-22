import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024
const ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'] as const
const PRIVATE_ARGUMENTS = new Set(['__permission', '_sig', '_nonce', 'permissionId', 'permission_id', 'tunnelId', 'tunnel_id', 'nodeId', 'node_id'])

function candidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.CUA_DRIVER_BIN,
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
    '/usr/local/bin/cua-driver',
    '/opt/homebrew/bin/cua-driver',
  ].filter((value): value is string => Boolean(value))
}

export function findCuaDriverBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of candidates(env)) {
    if (!existsSync(candidate)) continue
    const resolved = realpathSync(candidate)
    const info = statSync(resolved)
    if (!info.isFile()) throw new Error(`cua-driver is not a regular file: ${candidate}`)
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
      if (uid !== undefined && info.uid !== uid && info.uid !== 0) throw new Error(`cua-driver is not owned by the current user or root: ${resolved}`)
      if ((info.mode & 0o022) !== 0) throw new Error(`cua-driver must not be writable by group or other users: ${resolved}`)
      if ((info.mode & 0o111) === 0) throw new Error(`cua-driver is not executable: ${resolved}`)
    }
    return resolved
  }
  return null
}

function driverEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const key of ENV_KEYS) if (env[key] !== undefined) clean[key] = env[key]
  return clean
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !PRIVATE_ARGUMENTS.has(key)))
}

function daemonUnavailable(message: string): boolean {
  return message.includes('daemon proxy') && message.includes('Resource temporarily unavailable')
}

export class NativeCuaDriver {
  private binary: string | null = null
  private daemonReady = false

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async ensureInstalled(): Promise<string> {
    if (this.binary && existsSync(this.binary)) return this.binary
    const found = findCuaDriverBinary(this.env)
    if (!found) throw new Error('cua-driver is not installed. Install it locally before enabling Computer Use')
    this.binary = found
    return found
  }

  async version(signal?: AbortSignal): Promise<string> { return (await this.exec(['--version'], 10_000, signal)).stdout.trim() }
  async status(signal?: AbortSignal): Promise<string> { return (await this.exec(['status'], 10_000, signal)).stdout.trim() }
  async listTools(signal?: AbortSignal): Promise<string> { return (await this.exec(['list-tools'], 10_000, signal)).stdout.trim() }
  async describe(tool: string, signal?: AbortSignal): Promise<string> {
    if (!tool) throw new Error('CUA tool name is required')
    return (await this.exec(['describe', tool], 10_000, signal)).stdout.trim()
  }

  async startDaemon(): Promise<{ ok: true; status?: string }> {
    const binary = await this.ensureInstalled()
    const command = platform() === 'darwin' ? 'open' : binary
    const args = platform() === 'darwin' ? ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve'] : ['serve']
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: driverEnvironment(this.env) })
    child.unref()
    await Bun.sleep(750)
    try {
      const status = await this.status()
      this.daemonReady = true
      return { ok: true, status }
    } catch { return { ok: true } }
  }

  async call(tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (!tool) throw new Error('CUA tool name is required')
    await this.ensureDaemonReady()
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await this.exec(['call', tool, JSON.stringify(sanitizeArgs(args))], 60_000, signal)
        if (daemonUnavailable(result.stderr)) throw new Error(result.stderr.trim())
        const output = result.stdout.trim()
        if (!output) return {}
        try { return JSON.parse(output) } catch { return output }
      } catch (error) {
        if (!daemonUnavailable(error instanceof Error ? error.message : String(error))) throw error
        lastError = error
        await Bun.sleep(150 * (attempt + 1))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async ensureDaemonReady(): Promise<void> {
    if (this.daemonReady) return
    try {
      const status = await this.status()
      if (/not\s+running|stopped|unavailable/i.test(status)) throw new Error(status)
      this.daemonReady = true
    } catch {
      await this.startDaemon()
      this.daemonReady = true
    }
  }

  private async exec(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    const binary = await this.ensureInstalled()
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: driverEnvironment(this.env) })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let settled = false
      const finishError = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        child.kill('SIGKILL')
        reject(error)
      }
      const append = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > MAX_OUTPUT_BYTES) finishError(new Error('cua-driver output exceeds the 5 MiB limit'))
        else target.push(chunk)
      }
      const abort = () => finishError(new Error('cua-driver call aborted'))
      const timer = setTimeout(() => finishError(new Error(`${binary} timed out after ${timeoutMs}ms`)), timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
      child.once('error', finishError)
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const result = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
        if (code !== 0) reject(new Error(`${binary} failed (${code})${(result.stderr.trim() || result.stdout.trim()) ? `: ${result.stderr.trim() || result.stdout.trim()}` : ''}`))
        else resolve(result)
      })
    })
  }
}
