import { existsSync, mkdirSync, chmodSync } from 'fs'
import { dirname } from 'path'
import { execFileSync, execSync } from 'child_process'
import { sysbin } from './sysbin'
import type { DaemonSpec, DaemonInfo } from './schema'
import { projectGroupName } from './projects'

const PORT_BASE = 4097
const UID_MIN = 10_000
const UID_MAX = 19_999
const IDLE_MS = 15 * 60 * 1000
const REAP_INTERVAL_MS = 60 * 1000
const SPAWN_TIMEOUT_MS = 30_000
const STORAGE_SUBDIRS = [
  'log',
  'storage',
  'snapshot',
  'tool-output',
  'plugins',
  'workspace',
  'delegations',
]
function resolveOpencodeBin(): string {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN
  }
  for (const candidate of [
    '/usr/local/bin/opencode-kortix',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  try {
    return execSync('command -v opencode-kortix || command -v opencode', { encoding: 'utf8' }).trim()
  } catch {
    return 'opencode'
  }
}

const OPENCODE_BIN = resolveOpencodeBin()
const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR || '/ephemeral/kortix-master/opencode'
const MEMBER_HOME_ROOT = process.env.KORTIX_MEMBER_HOME_ROOT || '/srv/kortix/home'
const DB_WRITER_GROUP = process.env.KORTIX_DB_WRITER_GROUP || 'kortix_db'
const WORKSPACE_DIR = process.env.KORTIX_WORKSPACE || '/workspace'

interface Daemon {
  supabase_user_id: string
  username: string
  linux_uid: number
  port: number
  pid: number
  adopted?: boolean
  process: ReturnType<typeof Bun.spawn> | null
  startedAt: number
  lastUsed: number
}

export class DaemonRegistry {
  private byUser = new Map<string, Daemon>()
  private reapTimer: ReturnType<typeof setInterval> | null = null

  portFor(uid: number): number {
    if (uid < UID_MIN || uid > UID_MAX) {
      throw new Error(`uid ${uid} out of range [${UID_MIN}, ${UID_MAX}]`)
    }
    return PORT_BASE + (uid - UID_MIN)
  }

  async ensure(spec: DaemonSpec): Promise<number> {
    const existing = this.byUser.get(spec.supabase_user_id)
    if (existing && this.isAlive(existing) && (await this.isPortHealthy(existing.port))) {
      existing.lastUsed = Date.now()
      return existing.port
    }
    if (existing) {
      this.killProcess(existing)
      this.byUser.delete(spec.supabase_user_id)
    }

    const port = this.portFor(spec.linux_uid)

    if (await this.isPortHealthy(port)) {
      // Look up the adopted child's PID from /proc so a later stop()
      // (auth refresh, key rotation, daemon-restart admin action) can
      // actually kill it. Without this the daemon record carries pid=0
      // and killProcess silently no-ops.
      const adoptedPid = this.lookupPidByPort(port) ?? 0
      const adopted: Daemon = {
        supabase_user_id: spec.supabase_user_id,
        username: spec.username,
        linux_uid: spec.linux_uid,
        port,
        pid: adoptedPid,
        adopted: true,
        process: null,
        startedAt: Date.now(),
        lastUsed: Date.now(),
      }
      this.byUser.set(spec.supabase_user_id, adopted)
      console.log(`[supervisor] adopted existing daemon on port ${port} for ${spec.username} (pid=${adoptedPid})`)
      return port
    }

    this.ensureLinuxIdentity(spec)
    this.prepareStorage(spec)
    const daemon = await this.spawnDaemon(spec, port)
    this.byUser.set(spec.supabase_user_id, daemon)
    return port
  }

  private ensureLinuxIdentity(spec: DaemonSpec): void {
    const homeDir = `${MEMBER_HOME_ROOT}/${spec.username}`

    if (!this.groupExists(spec.username)) {
      try {
        execFileSync(sysbin('groupadd'), ['--gid', String(spec.linux_uid), spec.username], { stdio: 'ignore' })
      } catch (err) {
        if (!this.groupExists(spec.username)) {
          console.warn(`[supervisor] groupadd ${spec.username} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    }

    if (!this.userExists(spec.username)) {
      try {
        execFileSync(
          sysbin('useradd'),
          [
            '--uid', String(spec.linux_uid),
            '--gid', String(spec.linux_uid),
            '--no-create-home',
            '--home-dir', homeDir,
            '--shell', '/bin/bash',
            spec.username,
          ],
          { stdio: 'ignore' },
        )
        console.log(
          `[supervisor] useradd user=${spec.username} uid=${spec.linux_uid}`,
        )
      } catch (err) {
        if (!this.userExists(spec.username)) {
          throw new Error(
            `useradd failed for ${spec.username}: ${err instanceof Error ? err.message : err}`,
          )
        }
      }
    }

    if (!existsSync(homeDir)) {
      mkdirSync(homeDir, { recursive: true })
    }
    const subdirs = ['.kortix', 'projects', 'workspace', 'workspace/uploads', '.config', '.config/opencode']
    for (const sub of subdirs) {
      const p = `${homeDir}/${sub}`
      if (!existsSync(p)) mkdirSync(p, { recursive: true })
    }
    try {
      execFileSync(sysbin('chown'), ['-R', `${spec.linux_uid}:${spec.linux_uid}`, homeDir], { stdio: 'ignore' })
      chmodSync(homeDir, 0o700)
      for (const sub of subdirs) chmodSync(`${homeDir}/${sub}`, 0o700)
    } catch {}

    this.ensureWriterGroup()
    if (!this.userInGroup(spec.username, DB_WRITER_GROUP)) {
      try {
        execFileSync(sysbin('gpasswd'), ['-a', spec.username, DB_WRITER_GROUP], { stdio: 'ignore' })
      } catch (err) {
        console.warn(
          `[supervisor] gpasswd -a ${spec.username} ${DB_WRITER_GROUP} failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    for (const projectId of spec.project_ids ?? []) {
      const group = projectGroupName(projectId)
      if (!this.groupExists(group)) {
        try {
          execFileSync(sysbin('groupadd'), [group], { stdio: 'ignore' })
        } catch {}
      }
      if (this.groupExists(group) && !this.userInGroup(spec.username, group)) {
        try {
          execFileSync(sysbin('gpasswd'), ['-a', spec.username, group], { stdio: 'ignore' })
        } catch (err) {
          console.warn(
            `[supervisor] gpasswd -a ${spec.username} ${group} failed: ${err instanceof Error ? err.message : err}`,
          )
        }
      }
    }
  }

  private ensureWriterGroup(): void {
    if (this.groupExists(DB_WRITER_GROUP)) return
    try {
      execFileSync(sysbin('groupadd'), [DB_WRITER_GROUP], { stdio: 'ignore' })
    } catch (err) {
      if (!this.groupExists(DB_WRITER_GROUP)) {
        console.warn(`[supervisor] groupadd ${DB_WRITER_GROUP} failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  private userExists(username: string): boolean {
    try {
      execFileSync(sysbin('getent'), ['passwd', username], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  private groupExists(name: string): boolean {
    try {
      execFileSync(sysbin('getent'), ['group', name], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  private userInGroup(username: string, group: string): boolean {
    try {
      const out = execFileSync(sysbin('id'), ['-Gn', username], { encoding: 'utf8' })
      return out.split(/\s+/).includes(group)
    } catch {
      return false
    }
  }

  async stop(supabase_user_id: string): Promise<void> {
    const d = this.byUser.get(supabase_user_id)
    if (!d) return
    this.killProcess(d)
    this.byUser.delete(supabase_user_id)
  }

  async stopByUsername(username: string): Promise<void> {
    for (const [userId, d] of this.byUser) {
      if (d.username === username) {
        this.killProcess(d)
        this.byUser.delete(userId)
        return
      }
    }
  }

  list(): DaemonInfo[] {
    return Array.from(this.byUser.values()).map((d) => ({
      supabase_user_id: d.supabase_user_id,
      username: d.username,
      linux_uid: d.linux_uid,
      port: d.port,
      pid: d.pid,
      started_at: d.startedAt,
      last_used: d.lastUsed,
    }))
  }

  startIdleReaper(): void {
    if (this.reapTimer) return
    this.reapTimer = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS)
  }

  async shutdown(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    for (const d of this.byUser.values()) this.killProcess(d)
    this.byUser.clear()
  }

  private reapIdle(): void {
    const cutoff = Date.now() - IDLE_MS
    for (const [userId, d] of this.byUser) {
      if (d.lastUsed < cutoff) {
        console.log(
          `[supervisor] idle-kill ${d.username} uid=${d.linux_uid} port=${d.port} pid=${d.pid}`,
        )
        this.killProcess(d)
        this.byUser.delete(userId)
      }
    }
  }

  private prepareStorage(spec: DaemonSpec): void {
    if (!existsSync(spec.storage_base)) {
      mkdirSync(spec.storage_base, { recursive: true })
    }

    const dbPath = `${spec.storage_base}/opencode.db`
    const needsMigration =
      !!spec.migrate_from &&
      spec.migrate_from !== spec.storage_base &&
      existsSync(`${spec.migrate_from}/opencode.db`) &&
      !existsSync(dbPath)

    if (needsMigration) {
      console.log(
        `[supervisor] migrating ${spec.migrate_from} -> ${spec.storage_base} for ${spec.username}`,
      )
      try {
        execSync(`cp -a "${spec.migrate_from!}/." "${spec.storage_base}/"`, {
          stdio: 'inherit',
        })
      } catch (err) {
        throw new Error(
          `migration failed from ${spec.migrate_from} to ${spec.storage_base}: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    for (const sub of STORAGE_SUBDIRS) {
      const dir = `${spec.storage_base}/${sub}`
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }
    try {
      execSync(`chown -R ${spec.linux_uid}:${spec.linux_uid} ${spec.storage_base}`, {
        stdio: 'ignore',
      })
    } catch (err) {
      console.warn(
        `[supervisor] chown storage failed for ${spec.username}: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  private async spawnDaemon(spec: DaemonSpec, port: number): Promise<Daemon> {
    const homeDir = `/srv/kortix/home/${spec.username}`
    const env: Record<string, string> = {
      HOME: homeDir,
      PATH: '/opt/bun/bin:/usr/local/bin:/usr/bin:/bin',
      OPENCODE_STORAGE_BASE: spec.storage_base,
      OPENCODE_CONFIG_DIR,
      OPENCODE_FILE_ROOT: '/',
      XDG_DATA_HOME: dirname(spec.storage_base),
      KORTIX_WORKSPACE: '/workspace',
      KORTIX_USER_ID: spec.supabase_user_id,
      KORTIX_USER_ROLE: spec.role ?? 'member',
    }
    const forwardKeys = [
      'KORTIX_PERSISTENT_ROOT',
      'KORTIX_XDG_DIR',
      'KORTIX_KORTIX_STATE_DIR',
      'KORTIX_OPENCODE_ARCHIVE_DIR',
      'KORTIX_OPENCODE_CACHE_DIR',
      'KORTIX_TOKEN',
      'KORTIX_API_URL',
      'KORTIX_YOLO_API_KEY',
      'KORTIX_YOLO_URL',
      'KORTIX_SANDBOX_VERSION',
      'KORTIX_AGENT_BROWSER_DIR',
      'KORTIX_BROWSER_PROFILE_DIR',
      'OPENCODE_SHADOW_STORAGE_BASE',
      'OPENCODE_BIN_PATH',
      'AUTH_JSON_PATH',
      'INTERNAL_SERVICE_KEY',
      // LLM provider credentials. Without these the per-user daemon's
      // @ai-sdk providers resolve `{env:<KEY>}` to empty at SDK-load time
      // and every outbound call to api.anthropic.com / api.openai.com /
      // openrouter / google / xai / groq returns 401 "x-api-key header
      // is required". Auth-sync writes these to the s6 container env on
      // any /auth/<provider> change in the legacy daemon, kortix-master
      // fanout writes them to each daemon's auth.json, and we forward
      // them here so the daemon process actually inherits them at spawn.
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENROUTER_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'XAI_API_KEY',
      'GROQ_API_KEY',
    ]
    for (const key of forwardKeys) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    // Defensive catch-all: forward any remaining `*_API_KEY` / `*_API_URL`
    // env vars supervisor's process picked up. Future providers (a new
    // model gateway, a custom OpenAI-compatible base URL the user pasted
    // into Connectors) reach the daemon without requiring a code change
    // here every time. Skip ones already explicitly listed.
    const explicit = new Set(forwardKeys)
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue
      if (explicit.has(key)) continue
      if (!/_(API_KEY|API_URL|BASE_URL)$/.test(key)) continue
      env[key] = value
    }

    const workspaceDir = env.KORTIX_WORKSPACE || '/workspace'
    const proc = Bun.spawn(
      [
        '/bin/sh',
        '-c',
        `umask 0027; exec s6-setuidgid ${spec.username} ${OPENCODE_BIN} serve --port ${port} --hostname 127.0.0.1`,
      ],
      {
        env,
        cwd: workspaceDir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    this.pipeLogs(proc, spec.username)

    const ready = await this.waitForPort(port, SPAWN_TIMEOUT_MS)
    if (!ready) {
      proc.kill()
      throw new Error(
        `daemon for ${spec.username} failed to bind port ${port} within ${SPAWN_TIMEOUT_MS}ms`,
      )
    }

    const pid = proc.pid ?? 0
    console.log(
      `[supervisor] spawn ok user=${spec.username} uid=${spec.linux_uid} port=${port} pid=${pid}`,
    )
    return {
      supabase_user_id: spec.supabase_user_id,
      username: spec.username,
      linux_uid: spec.linux_uid,
      port,
      pid,
      process: proc,
      startedAt: Date.now(),
      lastUsed: Date.now(),
    }
  }

  private pipeLogs(proc: ReturnType<typeof Bun.spawn>, username: string): void {
    const tag = `[opencode:${username}]`
    const forward = async (stream: ReadableStream<Uint8Array> | undefined, sink: NodeJS.WriteStream) => {
      if (!stream) return
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of stream as any) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line) sink.write(`${tag} ${line}\n`)
        }
      }
      if (buf) sink.write(`${tag} ${buf}\n`)
    }
    forward(proc.stdout as any, process.stdout).catch(() => {})
    forward(proc.stderr as any, process.stderr).catch(() => {})
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/app`, {
          signal: AbortSignal.timeout(500),
        })
        if (res.status < 500) return true
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }

  private isAlive(d: Daemon): boolean {
    if (d.adopted) return true
    if (!d.pid) return false
    try {
      process.kill(d.pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async isPortHealthy(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app`, {
        signal: AbortSignal.timeout(1_000),
      })
      return res.status < 500
    } catch {
      return false
    }
  }

  private killProcess(d: Daemon): void {
    if (d.process) {
      try { d.process.kill('SIGTERM') } catch {}
      setTimeout(() => {
        try { d.process?.kill('SIGKILL') } catch {}
      }, 3000)
      return
    }
    // Adopted daemon path: process handle is null and pid was 0 at adoption
    // time. Fall back to a port → pid lookup so admin-driven restarts (auth
    // refresh, model swap, supervisor upgrade) actually take effect on the
    // adopted child instead of silently doing nothing.
    let pid = d.pid
    if (!pid) {
      pid = this.lookupPidByPort(d.port) ?? 0
      if (pid) d.pid = pid
    }
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }, 3000)
    } else {
      console.warn(
        `[supervisor] killProcess: no pid for adopted daemon user=${d.username} port=${d.port}`,
      )
    }
  }

  private lookupPidByPort(port: number): number | null {
    // /proc/net/tcp and /proc/net/tcp6 are the kernel-exposed socket tables
    // — readable by any user. We parse the local port (4-byte hex on the
    // 2nd column) and the inode (10th column), then map inode → pid by
    // scanning /proc/<pid>/fd/* symlinks for "socket:[<inode>]".
    //
    // Cheaper than spawning lsof / ss / fuser, no extra binaries, no root
    // requirement to read the socket table itself (only need root to find
    // pids running as other users — supervisor IS root).
    try {
      const inodes = new Set<string>()
      for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let body: string
        try { body = require('fs').readFileSync(file, 'utf8') } catch { continue }
        const lines = body.split('\n').slice(1) // drop header
        for (const line of lines) {
          const cols = line.trim().split(/\s+/)
          if (cols.length < 10) continue
          const localAddr = cols[1] // e.g. "0100007F:1002" → 127.0.0.1:4098
          const portHex = localAddr.split(':')[1]
          if (!portHex) continue
          if (parseInt(portHex, 16) !== port) continue
          if (cols[3] !== '0A') continue // 0A = LISTEN
          inodes.add(cols[9])
        }
      }
      if (inodes.size === 0) return null
      const fs = require('fs') as typeof import('fs')
      for (const pidStr of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pidStr)) continue
        const fdDir = `/proc/${pidStr}/fd`
        let entries: string[]
        try { entries = fs.readdirSync(fdDir) } catch { continue }
        for (const fd of entries) {
          let target: string
          try { target = fs.readlinkSync(`${fdDir}/${fd}`) } catch { continue }
          const m = target.match(/^socket:\[(\d+)\]$/)
          if (!m) continue
          if (inodes.has(m[1])) return parseInt(pidStr, 10)
        }
      }
    } catch (err) {
      console.warn(`[supervisor] lookupPidByPort(${port}) failed: ${err instanceof Error ? err.message : err}`)
    }
    return null
  }
}
