import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { NodeCapabilityHandler, NodeCapabilityName, NodeCapabilityRegistry } from './types'
import { sandboxNodePolicy, type NodeLocalPolicy } from '../policy-store'
import { findCuaDriverBinary, NativeCuaDriver } from './cua-driver'

const SANDBOX_ROOTS = ['/workspace', '/tmp', '/home', '/opt']
const COMMAND_METACHARS = /[;&|`$(){}[\]<>!#~]/
const CUA_TOOLS = [
  'bring_to_front', 'check_permissions', 'click', 'double_click', 'drag', 'end_session',
  'get_accessibility_tree', 'get_agent_cursor_state', 'get_config', 'get_cursor_position',
  'get_recording_state', 'get_screen_size', 'get_window_state', 'hotkey', 'kill_app',
  'launch_app', 'list_apps', 'list_windows', 'move_cursor', 'page', 'press_key',
  'replay_trajectory', 'right_click', 'scroll', 'set_agent_cursor_enabled',
  'set_agent_cursor_motion', 'set_agent_cursor_style', 'set_config', 'set_value',
  'start_recording', 'start_session', 'stop_recording', 'type_text', 'zoom',
] as const

function existingRoot(path: string): string {
  try { return realpathSync(path) } catch { return normalize(resolve(path)) }
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function resolveSafe(path: unknown, write: boolean, policy: NodeLocalPolicy, assignmentRoots: readonly string[]): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Path must be absolute')
  const requested = normalize(resolve(path))
  let resolved: string
  try {
    resolved = realpathSync(requested)
  } catch (error) {
    if (!write || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot resolve path: ${path}`)
    let parent = dirname(requested)
    const missing: string[] = [basename(requested)]
    while (parent !== dirname(parent)) {
      try {
        resolved = join(realpathSync(parent), ...missing.reverse())
        break
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot resolve path: ${path}`)
        missing.push(basename(parent))
        parent = dirname(parent)
      }
    }
    resolved ??= requested
  }
  if (policy.blockedPaths.some((root) => inside(resolved, existingRoot(root)))) throw new Error(`Access denied: blocked path "${path}"`)
  if (!policy.allowedPaths.some((root) => inside(resolved, existingRoot(root)))) throw new Error(`Access denied: path "${path}" is outside local allowed roots`)
  if (assignmentRoots.length > 0 && !assignmentRoots.some((root) => inside(resolved, existingRoot(root)))) throw new Error(`Access denied: path "${path}" is outside assignment roots`)
  return resolved
}

function encoding(value: unknown): 'utf8' | 'base64' {
  if (value === undefined || value === 'utf8' || value === 'utf-8') return 'utf8'
  if (value === 'base64') return 'base64'
  throw new Error('Encoding must be utf8 or base64')
}

function filesystemMethods(policy: () => NodeLocalPolicy, roots: () => readonly string[]): Map<string, NodeCapabilityHandler> {
  return new Map<string, NodeCapabilityHandler>([
    ['fs.read', async (params) => {
      const current = policy()
      const path = resolveSafe(params.path, false, current, roots())
      const format = encoding(params.encoding)
      const handle = await open(path, 'r')
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error('Path is not a regular file')
        if (info.size > current.maxFileSize) throw new Error(`File exceeds ${current.maxFileSize} bytes`)
        return { content: await handle.readFile({ encoding: format }), size: info.size, encoding: format }
      } finally { await handle.close() }
    }],
    ['fs.write', async (params) => {
      const current = policy()
      const path = resolveSafe(params.path, true, current, roots())
      const content = params.content
      const format = encoding(params.encoding)
      if (typeof content !== 'string') throw new Error('Content must be a string')
      if (Buffer.byteLength(content, format) > current.maxFileSize) throw new Error(`Content exceeds ${current.maxFileSize} bytes`)
      await mkdir(dirname(path), { recursive: true })
      resolveSafe(path, true, current, roots())
      await writeFile(path, content, { encoding: format, mode: 0o600 })
      return { path, size: (await stat(path)).size }
    }],
    ['fs.list', async (params) => {
      const path = resolveSafe(params.path, false, policy(), roots())
      const entries = await readdir(path, { withFileTypes: true })
      return { entries: entries.map((entry) => ({ name: entry.name, path: join(path, entry.name), isDirectory: entry.isDirectory(), isFile: entry.isFile(), isSymlink: entry.isSymbolicLink() })), count: entries.length }
    }],
    ['fs.stat', async (params) => {
      const info = await stat(resolveSafe(params.path, false, policy(), roots()))
      return { size: info.size, isDirectory: info.isDirectory(), isFile: info.isFile(), isSymlink: info.isSymbolicLink(), mode: info.mode, mtime: info.mtime.toISOString(), ctime: info.ctime.toISOString(), atime: info.atime.toISOString() }
    }],
    ['fs.delete', async (params) => {
      const path = resolveSafe(params.path, false, policy(), roots())
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Only regular files can be deleted')
      await unlink(path)
      return { deleted: true, path }
    }],
  ])
}

function shellMethods(policy: () => NodeLocalPolicy, roots: () => readonly string[]): Map<string, NodeCapabilityHandler> {
  return new Map([['shell.exec', async (params, signal) => {
    const current = policy()
    if (typeof params.command !== 'string' || !params.command.trim() || COMMAND_METACHARS.test(params.command)) throw new Error('Invalid command')
    const command = params.command.trim()
    if (current.blockedCommands.includes(command)) throw new Error(`Command "${command}" is blocked`)
    if (current.allowedCommands.length > 0 && !current.allowedCommands.includes(command)) throw new Error(`Command "${command}" is outside the local allowlist`)
    const args = params.args ?? []
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Command args must be strings')
    const assigned = roots()
    const cwd = resolveSafe(params.cwd ?? assigned[0] ?? current.allowedPaths[0], false, current, assigned)
    const requestedTimeout = params.timeout === undefined ? current.shellTimeout : Number(params.timeout)
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) throw new Error('Command timeout must be a positive integer')
    const timeout = Math.min(requestedTimeout, current.shellMaxTimeout)
    const env: Record<string, string> = { TERM: 'dumb' }
    for (const key of current.shellEnvPassthrough) if (process.env[key] !== undefined) env[key] = process.env[key]!
    return await new Promise((resolveResult, reject) => {
      const child = spawn(params.command as string, args as string[], { cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stdoutTruncated = false
      let stderrTruncated = false
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, mark: () => void): Buffer<ArrayBufferLike> => {
        const remaining = policy().shellMaxOutputSize - current.byteLength
        if (remaining <= 0) { mark(); return current }
        if (chunk.byteLength > remaining) mark()
        return Buffer.concat([current, chunk.subarray(0, remaining)])
      }
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk, () => { stdoutTruncated = true }) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk, () => { stderrTruncated = true }) })
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
      const abort = () => child.kill('SIGKILL')
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
      child.once('close', (exitCode, exitSignal) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolveResult({ exitCode, signal: exitSignal, stdout: stdout.toString(), stderr: stderr.toString(), stdoutTruncated, stderrTruncated })
      })
    })
  }]])
}

export function createSandboxCapabilityRegistry(): NodeCapabilityRegistry {
  return createNodeCapabilityRegistry({ assignmentRoots: () => SANDBOX_ROOTS, policy: sandboxNodePolicy })
}

/** Create host capabilities constrained to roots supplied by the active lease. */
export function createNodeCapabilityRegistry(options: { assignmentRoots: () => readonly string[]; policy: () => NodeLocalPolicy }): NodeCapabilityRegistry {
  const current = options.policy()
  const methods = new Map<string, NodeCapabilityHandler>()
  const names: NodeCapabilityName[] = []
  if (current.enabledCapabilities.includes('filesystem')) { for (const entry of filesystemMethods(options.policy, options.assignmentRoots)) methods.set(...entry); names.push('filesystem') }
  if (current.enabledCapabilities.includes('shell')) { for (const entry of shellMethods(options.policy, options.assignmentRoots)) methods.set(...entry); names.push('shell') }
  try {
    const driver = new NativeCuaDriver()
    if (current.enabledCapabilities.includes('desktop') && findCuaDriverBinary()) {
      methods.set('desktop.cua.ensure', async (_params, signal) => ({ ok: true, binary: await driver.ensureInstalled(), version: await driver.version(signal) }))
      methods.set('desktop.cua.start_daemon', async () => driver.startDaemon())
      methods.set('desktop.cua.status', async (_params, signal) => ({ status: await driver.status(signal) }))
      methods.set('desktop.cua.version', async (_params, signal) => ({ version: await driver.version(signal) }))
      methods.set('desktop.cua.list_tools', async (_params, signal) => ({ tools: await driver.listTools(signal) }))
      methods.set('desktop.cua.describe', async (params, signal) => {
        if (typeof params.tool !== 'string' || !params.tool) throw new Error('CUA tool is required')
        return { description: await driver.describe(params.tool, signal) }
      })
      methods.set('desktop.cua.call', async (params, signal) => {
        if (typeof params.tool !== 'string' || !params.tool) throw new Error('CUA tool is required')
        if (params.tool === 'check_for_update' || params.tool === 'install_ffmpeg') throw new Error(`CUA tool "${params.tool}" is local-only`)
        return driver.call(params.tool, params.args as Record<string, unknown> ?? {}, signal)
      })
      for (const tool of CUA_TOOLS) {
        methods.set(`desktop.cua.${tool}`, async (params, signal) => driver.call(tool, params, signal))
      }
      names.push('desktop')
    }
  } catch {
    // Desktop remains unregistered when no trusted local driver exists.
  }
  return { methods, names }
}

export type { NodeCapabilityRegistry } from './types'
