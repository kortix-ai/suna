import type { OpencodeClient } from '@opencode-ai/sdk'
import { RingBuffer } from './buffer.ts'
import { SessionLifecycleManager } from './session-lifecycle.ts'
import type { PTYSession, PTYSessionInfo, ReadResult, SearchResult, SpawnOptions } from './types.ts'

type BuiltinPtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: 'running' | 'exited'
  pid: number
}

type SessionUpdateCallback = (session: PTYSessionInfo) => void
type RawOutputCallback = (session: PTYSessionInfo, rawData: string) => void

export const sessionUpdateCallbacks: SessionUpdateCallback[] = []
export const rawOutputCallbacks: RawOutputCallback[] = []

export function registerSessionUpdateCallback(callback: SessionUpdateCallback) {
  sessionUpdateCallbacks.push(callback)
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback) {
  const index = sessionUpdateCallbacks.indexOf(callback)
  if (index !== -1) sessionUpdateCallbacks.splice(index, 1)
}

export function registerRawOutputCallback(callback: RawOutputCallback): void {
  rawOutputCallbacks.push(callback)
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
  const index = rawOutputCallbacks.indexOf(callback)
  if (index !== -1) rawOutputCallbacks.splice(index, 1)
}

function notifySessionUpdate(session: PTYSessionInfo) {
  for (const callback of sessionUpdateCallbacks) {
    try {
      callback(session)
    } catch {}
  }
}

function notifyRawOutput(session: PTYSessionInfo, rawData: string): void {
  for (const callback of rawOutputCallbacks) {
    try {
      callback(session, rawData)
    } catch {}
  }
}

let _client: OpencodeClient | null = null
let _directory = process.cwd()
let _httpBase = 'http://127.0.0.1:4096'
let _wsBase = 'ws://127.0.0.1:4096'
let _backendAvailable = true
let _backendLoadError: string | null = null

function normalizeBase(input: URL | string | undefined, protocol: 'http' | 'ws'): string {
  const url = typeof input === 'string' ? new URL(input) : new URL(input?.toString() ?? 'http://127.0.0.1:4096')
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  url.protocol = protocol === 'ws'
    ? (url.protocol === 'https:' ? 'wss:' : 'ws:')
    : (url.protocol === 'wss:' ? 'https:' : 'http:')
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${_httpBase}${path}`, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PTY backend ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`)
  }
  return (await res.json()) as T
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

class PTYManager {
  private sessions = new Map<string, PTYSession>()
  private localSessions = new SessionLifecycleManager()

  init(client: OpencodeClient, serverUrl?: URL, directory?: string): void {
    _client = client
    if (directory) _directory = directory
    _httpBase = normalizeBase(serverUrl, 'http')
    _wsBase = normalizeBase(serverUrl, 'ws')
    _backendAvailable = true
    _backendLoadError = null
  }

  async probe(): Promise<void> {
    try {
      await request<BuiltinPtyInfo[]>('/pty')
      _backendAvailable = true
      _backendLoadError = null
    } catch (err) {
      _backendAvailable = false
      _backendLoadError = err instanceof Error ? err.message : String(err)
    }
  }

  clearAllSessions(): void {
    for (const session of this.sessions.values()) {
      try {
        session.process?.kill?.()
      } catch {}
    }
    this.sessions.clear()
    this.localSessions.clearAllSessions()
  }

  private toInfo(session: PTYSession): PTYSessionInfo {
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

  private async sendExitNotification(session: PTYSession): Promise<void> {
    if (!_client || !session.notifyOnExit) return
    const lines = [
      '<pty_exited>',
      `ID: ${session.id}`,
      `Title: ${session.title}`,
      `Exit code: ${session.exitCode ?? 'unknown'}`,
      `Output lines: ${session.buffer.length}`,
      '</pty_exited>',
    ]
    try {
      await _client.session.prompt({
        path: { id: session.parentSessionId },
        body: { noReply: true, parts: [{ type: 'text', text: lines.join('\n') }] },
      })
    } catch {}
  }

  private connectSocket(session: PTYSession): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${_wsBase}/pty/${session.id}/connect`)
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      ws.onopen = () => {
        session.process = {
          pid: session.pid,
          onData: () => {},
          onExit: () => {},
          write: (data: string) => ws.send(data),
          kill: () => ws.close(),
        }
        settle(resolve)
      }

      ws.onmessage = (event) => {
        const text = typeof event.data === 'string' ? event.data : ''
        if (!text) return
        session.buffer.append(text)
        notifyRawOutput(this.toInfo(session), text)
        notifySessionUpdate(this.toInfo(session))
      }

      ws.onclose = async () => {
        session.status = session.status === 'killing' ? 'killed' : 'exited'
        notifySessionUpdate(this.toInfo(session))
        await this.sendExitNotification(session)
      }

      ws.onerror = () => {
        settle(() => reject(new Error(`PTY websocket connection failed for ${session.id}`)))
      }
    })
  }

  async spawn(opts: SpawnOptions): Promise<PTYSessionInfo> {
    if (!_backendAvailable) {
      await this.probe()
    }

    if (!_backendAvailable) {
      const info = await this.localSessions.spawn(
        opts,
        (session, rawData) => {
          notifyRawOutput(this.localSessions.toInfo(session), rawData)
          notifySessionUpdate(this.localSessions.toInfo(session))
        },
        async (session) => {
          notifySessionUpdate(this.localSessions.toInfo(session))
          await this.sendExitNotification(session)
        },
      )
      notifySessionUpdate(info)
      return info
    }

    const cwd = opts.workdir ?? _directory
    const created = await request<BuiltinPtyInfo>('/pty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: opts.command,
        args: opts.args ?? [],
        cwd,
        title: opts.title,
        env: opts.env,
      }),
    })

    const session: PTYSession = {
      id: created.id,
      title: created.title,
      description: opts.description,
      command: created.command,
      args: created.args,
      workdir: created.cwd,
      env: opts.env,
      status: created.status,
      pid: created.pid,
      createdAt: new Date().toISOString(),
      parentSessionId: opts.parentSessionId,
      parentAgent: opts.parentAgent,
      notifyOnExit: opts.notifyOnExit ?? false,
      buffer: new RingBuffer(),
      process: null,
    }

    this.sessions.set(session.id, session)
    try {
      await this.connectSocket(session)
    } catch (err) {
      this.sessions.delete(session.id)
      await request(`/pty/${session.id}`, { method: 'DELETE' }).catch(() => undefined)
      throw err
    }

    notifySessionUpdate(this.toInfo(session))
    return this.toInfo(session)
  }

  async write(id: string, data: string): Promise<boolean> {
    const localSession = this.localSessions.getSession(id)
    if (localSession?.process) {
      localSession.process.write(data)
      return true
    }

    const session = this.sessions.get(id)
    if (!session || !session.process) return false
    session.process.write(data)
    return true
  }

  read(id: string, offset: number = 0, limit?: number): ReadResult | null {
    const localSession = this.localSessions.getSession(id)
    if (localSession) {
      const lines = localSession.buffer.read(offset, limit)
      const totalLines = localSession.buffer.length
      return {
        lines,
        totalLines,
        offset,
        hasMore: offset + lines.length < totalLines,
      }
    }

    const session = this.sessions.get(id)
    if (!session) return null
    const lines = session.buffer.read(offset, limit)
    const totalLines = session.buffer.length
    return {
      lines,
      totalLines,
      offset,
      hasMore: offset + lines.length < totalLines,
    }
  }

  search(id: string, pattern: RegExp, offset: number = 0, limit?: number): SearchResult | null {
    const localSession = this.localSessions.getSession(id)
    if (localSession) {
      const matches = localSession.buffer.search(pattern)
      const paged = limit !== undefined ? matches.slice(offset, offset + limit) : matches.slice(offset)
      return {
        matches: paged,
        totalMatches: matches.length,
        totalLines: localSession.buffer.length,
        offset,
        hasMore: offset + paged.length < matches.length,
      }
    }

    const session = this.sessions.get(id)
    if (!session) return null
    const matches = session.buffer.search(pattern)
    const paged = limit !== undefined ? matches.slice(offset, offset + limit) : matches.slice(offset)
    return {
      matches: paged,
      totalMatches: matches.length,
      totalLines: session.buffer.length,
      offset,
      hasMore: offset + paged.length < matches.length,
    }
  }

  async list(): Promise<PTYSessionInfo[]> {
    try {
      if (_backendAvailable) {
        const live = await request<BuiltinPtyInfo[]>('/pty')
        const liveIds = new Set(live.map((item) => item.id))
        for (const item of live) {
          const existing = this.sessions.get(item.id)
          if (existing) {
            existing.title = item.title
            existing.command = item.command
            existing.args = item.args
            existing.workdir = item.cwd
            existing.status = item.status
            existing.pid = item.pid
          } else {
            this.sessions.set(item.id, {
              id: item.id,
              title: item.title,
              command: item.command,
              args: item.args,
              workdir: item.cwd,
              status: item.status,
              pid: item.pid,
              createdAt: new Date().toISOString(),
              parentSessionId: '',
              notifyOnExit: false,
              buffer: new RingBuffer(),
              process: null,
            })
          }
        }
        for (const [id, session] of this.sessions) {
          if (!liveIds.has(id) && session.status === 'running') session.status = 'exited'
        }
      }
    } catch {}
    return [
      ...Array.from(this.sessions.values()).map((session) => this.toInfo(session)),
      ...this.localSessions.listSessions().map((session) => this.localSessions.toInfo(session)),
    ]
  }

  get(id: string): PTYSessionInfo | null {
    const localSession = this.localSessions.getSession(id)
    if (localSession) return this.localSessions.toInfo(localSession)

    const session = this.sessions.get(id)
    return session ? this.toInfo(session) : null
  }

  async kill(id: string, cleanup: boolean = false): Promise<boolean> {
    if (this.localSessions.getSession(id)) {
      return this.localSessions.kill(id, cleanup)
    }

    const session = this.sessions.get(id)
    if (!session) return false
    session.status = 'killing'
    try {
      await request(`/pty/${id}`, { method: 'DELETE' })
    } catch {
      return false
    }
    session.status = 'killed'
    try {
      session.process?.kill?.()
    } catch {}
    if (cleanup) {
      session.buffer.clear()
      this.sessions.delete(id)
    }
    notifySessionUpdate(this.toInfo(session))
    return true
  }

  cleanupBySession(parentSessionId: string): void {
    this.localSessions.cleanupBySession(parentSessionId)
    for (const [id, session] of this.sessions) {
      if (session.parentSessionId === parentSessionId) {
        this.kill(id, true).catch(() => undefined)
      }
    }
  }
}

export const manager = new PTYManager()

export function isBunPtyAvailable(): boolean {
  return _backendAvailable
}

export function bunPtyLoadError(): string | null {
  return _backendLoadError
}

export function initManager(opcClient: OpencodeClient, serverUrl?: URL, directory?: string): void {
  manager.init(opcClient, serverUrl, directory)
  manager.probe().catch(() => undefined)
}

export async function ensurePtyBackendAvailable(): Promise<void> {
  if (_backendAvailable) return
  await manager.probe()
}

export function wrapPtyText(text: string): string {
  return escapeXml(text)
}
