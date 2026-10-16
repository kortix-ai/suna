import { RingBuffer } from './buffer.ts'
import type { PTYSession, PTYSessionInfo, SpawnOptions } from './types.ts'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../constants.ts'
import { existsSync } from 'node:fs'

// ── Lazy bun-pty import ─────────────────────────────────────────────────────
// bun-pty is a Bun-native module. Static imports crash the whole module graph
// if the native addon isn't available. We lazy-load at first spawn instead.
let _bunPtySpawn: ((...args: any[]) => any) | null = null
let _bunPtyLoadAttempted = false
let _bunPtyError: string | null = null

async function getBunPtySpawn(): Promise<(...args: any[]) => any> {
  if (_bunPtySpawn) return _bunPtySpawn

  if (_bunPtyLoadAttempted) {
    throw new Error(
      `[PTY spawn] bun-pty previously failed to load: ${_bunPtyError}. ` +
        `Cannot spawn PTY sessions. Fix the underlying issue and restart.`
    )
  }

  _bunPtyLoadAttempted = true
  try {
    const mod = await import('bun-pty') as any
    _bunPtySpawn = mod.spawn ?? mod.default?.spawn
    if (!_bunPtySpawn) {
      throw new Error(`bun-pty module loaded but 'spawn' export not found. Exports: ${Object.keys(mod).join(', ')}`)
    }
    return _bunPtySpawn
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    _bunPtyError = msg
    throw new Error(
      `[PTY spawn] Failed to load bun-pty native module.\n` +
        `  Error: ${msg}\n` +
        `  Platform: ${process.platform}/${process.arch}\n` +
        `  Runtime: ${typeof Bun !== 'undefined' ? `Bun ${(Bun as any).version}` : 'NOT Bun (bun-pty requires Bun!)'}\n` +
        `  Fix: cd plugin/opencode-pty && bun install`
    )
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────────
const SESSION_ID_BYTE_LENGTH = 4

function generateId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTE_LENGTH)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `pty_${hex}`
}

export class SessionLifecycleManager {
  private sessions: Map<string, PTYSession> = new Map()

  private createSessionObject(opts: SpawnOptions): PTYSession {
    const id = generateId()
    const args = opts.args ?? []
    const workdir = opts.workdir ?? process.cwd()
    const title =
      opts.title ?? (`${opts.command} ${args.join(' ')}`.trim() || `Terminal ${id.slice(-4)}`)

    const buffer = new RingBuffer()
    return {
      id,
      title,
      description: opts.description,
      command: opts.command,
      args,
      workdir,
      env: opts.env,
      status: 'running',
      pid: 0, // will be set after spawn
      createdAt: new Date().toISOString(),
      parentSessionId: opts.parentSessionId,
      parentAgent: opts.parentAgent,
      notifyOnExit: opts.notifyOnExit ?? false,
      buffer,
      process: null, // will be set
    }
  }

  private async spawnProcess(session: PTYSession): Promise<void> {
    // Pre-flight checks with actionable diagnostics
    if (!session.command) {
      throw new Error(`[PTY spawn] command is empty/undefined. Provide a valid command.`)
    }

    if (session.workdir && !existsSync(session.workdir)) {
      throw new Error(
        `[PTY spawn] workdir does not exist: "${session.workdir}". ` +
          `Create the directory first or omit workdir to use cwd.`
      )
    }

    const env = { ...process.env, ...session.env } as Record<string, string>
    const spawnContext = {
      command: session.command,
      args: session.args,
      workdir: session.workdir,
      envKeys: session.env ? Object.keys(session.env) : [],
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    }

    // Lazy-load bun-pty spawn
    const bunPtySpawn = await getBunPtySpawn()

    try {
      const ptyProcess = bunPtySpawn(session.command, session.args, {
        name: 'xterm-256color',
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
        cwd: session.workdir,
        env,
      })
      session.process = ptyProcess
      session.pid = ptyProcess.pid
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined

      // Classify the error for actionable diagnostics
      let hint = ''
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        hint = `Command "${session.command}" not found. Is it installed and on PATH?`
      } else if (msg.includes('EACCES') || msg.includes('permission')) {
        hint = `Permission denied running "${session.command}". Check file permissions.`
      } else if (msg.includes('EIO') || msg.includes('pty') || msg.includes('openpty')) {
        hint = `PTY allocation failed at OS level. Max PTYs reached? Check: sysctl kern.tty.ptmx_max (macOS) or /proc/sys/kernel/pty/max (Linux).`
      } else if (msg.includes('bun-pty') || msg.includes('native') || msg.includes('dlopen')) {
        hint = `bun-pty native module failed to load. Was it compiled for this platform? Try: cd opencode-pty && bun install`
      }

      const diagnostics = [
        `[PTY spawn FAILED]`,
        `  Error: ${msg}`,
        hint ? `  Hint: ${hint}` : null,
        `  Context: ${JSON.stringify(spawnContext)}`,
        stack ? `  Stack: ${stack.split('\n').slice(0, 5).join('\n    ')}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      console.error(diagnostics)
      throw new Error(diagnostics)
    }
  }

  private setupEventHandlers(
    session: PTYSession,
    onData: (session: PTYSession, data: string) => void,
    onExit: (session: PTYSession, exitCode: number | null) => void
  ): void {
    session.process?.onData((data: string) => {
      session.buffer.append(data)
      onData(session, data)
    })

    session.process?.onExit(({ exitCode, signal }) => {
      // Flush any remaining incomplete line in the buffer
      session.buffer.flush()

      if (session.status === 'killing') {
        session.status = 'killed'
      } else {
        session.status = 'exited'
      }
      session.exitCode = exitCode
      session.exitSignal = signal
      onExit(session, exitCode)
    })
  }

  async spawn(
    opts: SpawnOptions,
    onData: (session: PTYSession, data: string) => void,
    onExit: (session: PTYSession, exitCode: number | null) => void
  ): Promise<PTYSessionInfo> {
    const session = this.createSessionObject(opts)
    await this.spawnProcess(session)
    this.setupEventHandlers(session, onData, onExit)
    this.sessions.set(session.id, session)
    return this.toInfo(session)
  }

  kill(id: string, cleanup: boolean = false): boolean {
    const session = this.sessions.get(id)
    if (!session) {
      return false
    }

    if (session.status === 'running') {
      session.status = 'killing'
      try {
        session.process?.kill()
      } catch {
        // Ignore kill errors
      }
    }

    if (cleanup) {
      session.buffer.clear()
      this.sessions.delete(id)
    }

    return true
  }

  private clearAllSessionsInternal(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id, true)
    }
  }

  clearAllSessions(): void {
    this.clearAllSessionsInternal()
  }

  cleanupBySession(parentSessionId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.parentSessionId === parentSessionId) {
        this.kill(id, true)
      }
    }
  }

  getSession(id: string): PTYSession | null {
    return this.sessions.get(id) || null
  }

  listSessions(): PTYSession[] {
    return Array.from(this.sessions.values())
  }

  toInfo(session: PTYSession): PTYSessionInfo {
    return {
      id: session.id,
      title: session.title,
      description: session.description,
      command: session.command,
      args: session.args,
      workdir: session.workdir,
      status: session.status,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      pid: session.pid,
      createdAt: session.createdAt,
      lineCount: session.buffer.length,
    }
  }
}
