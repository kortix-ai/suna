/**
 * OpenCode's built-in glob starts ripgrep without a wall-clock deadline. A
 * recursive walk of an SSHFS mount can leave rg waiting in FUSE forever, which
 * keeps the whole turn busy. Only direct rg children of THIS OpenCode process
 * with the built-in glob's argv are eligible. Shell commands are unaffected.
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { logger } from './logger'

export const GLOB_DEADLINE_MS = 60_000
const GLOB_WATCH_INTERVAL_MS = 5_000
const TERM_GRACE_MS = 5_000

interface GlobProcess {
  pid: number
  startTicks: string
}

interface SeenGlob {
  startTicks: string
  firstSeenAt: number
  termAt: number | null
}

export interface GlobWatchdogOptions {
  opencodePid: () => number | null
  procRoot?: string
  now?: () => number
  kill?: (pid: number, signal: NodeJS.Signals) => void
  log?: (message: string, fields: Record<string, unknown>) => void
  deadlineMs?: number
}

/** Field 22 is the process start tick. The command field may contain spaces. */
export function procStartTicks(stat: string): string | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  const fields = stat.slice(end + 2).trim().split(/\s+/)
  return fields[19] || null
}

export function isOpenCodeGlobArgv(argv: string[]): boolean {
  return basename(argv[0] ?? '') === 'rg' &&
    argv.includes('--no-config') &&
    argv.includes('--files') &&
    argv.some((arg) => arg.startsWith('--glob='))
}

async function readGlobProcess(procRoot: string, pid: number, parentPid: number): Promise<GlobProcess | null> {
  const root = join(procRoot, String(pid))
  try {
    const status = await readFile(join(root, 'status'), 'utf8')
    if (Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) !== parentPid) return null
    const [cmdline, stat] = await Promise.all([
      readFile(join(root, 'cmdline')),
      readFile(join(root, 'stat'), 'utf8'),
    ])
    const argv = cmdline.toString('utf8').split('\0').filter(Boolean)
    const startTicks = procStartTicks(stat)
    if (!startTicks || !isOpenCodeGlobArgv(argv)) return null
    return { pid, startTicks }
  } catch {
    // A process can exit between readdir and readFile.
    return null
  }
}

async function globChildren(procRoot: string, parentPid: number): Promise<GlobProcess[]> {
  const names = await readdir(procRoot).catch(() => [])
  const children = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map((name) =>
    readGlobProcess(procRoot, Number(name), parentPid)
  ))
  return children.filter((child): child is GlobProcess => child !== null)
}

export function createOpenCodeGlobWatchdog(options: GlobWatchdogOptions) {
  const procRoot = options.procRoot ?? '/proc'
  const now = options.now ?? Date.now
  const kill = options.kill ?? process.kill
  const log = options.log ?? ((message, fields) => logger.warn(message, fields))
  const deadlineMs = options.deadlineMs ?? GLOB_DEADLINE_MS
  const seen = new Map<number, SeenGlob>()
  let lastParentPid: number | null = null
  let polling = false

  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const parentPid = options.opencodePid()
      if (parentPid !== lastParentPid) {
        seen.clear()
        lastParentPid = parentPid
      }
      if (!parentPid) return
      const children = await globChildren(procRoot, parentPid)
      const live = new Set(children.map((child) => child.pid))
      for (const pid of seen.keys()) if (!live.has(pid)) seen.delete(pid)
      const at = now()
      for (const child of children) {
        let entry = seen.get(child.pid)
        if (!entry || entry.startTicks !== child.startTicks) {
          entry = { startTicks: child.startTicks, firstSeenAt: at, termAt: null }
          seen.set(child.pid, entry)
        }
        const signal = entry.termAt === null
          ? at - entry.firstSeenAt >= deadlineMs ? 'SIGTERM' : null
          : at - entry.termAt >= TERM_GRACE_MS ? 'SIGKILL' : null
        if (!signal) continue
        // Recheck identity at the signal boundary. A pid can exit and be reused
        // after the directory scan; never signal its replacement.
        const current = await readGlobProcess(procRoot, child.pid, parentPid)
        if (current?.startTicks !== child.startTicks) {
          seen.delete(child.pid)
          continue
        }
        try {
          kill(child.pid, signal)
          if (signal === 'SIGTERM') entry.termAt = at
          else seen.delete(child.pid)
          log('[opencode-glob] stopped overdue search', {
            pid: child.pid,
            signal,
            elapsedMs: at - entry.firstSeenAt,
            deadlineMs,
          })
        } catch {
          seen.delete(child.pid)
        }
      }
    } finally {
      polling = false
    }
  }

  return { poll, clear: () => seen.clear() }
}

export function startOpenCodeGlobWatchdog(options: GlobWatchdogOptions): { stop: () => void } {
  const watchdog = createOpenCodeGlobWatchdog(options)
  const timer = setInterval(() => void watchdog.poll(), GLOB_WATCH_INTERVAL_MS)
  timer.unref?.()
  void watchdog.poll()
  return { stop: () => { clearInterval(timer); watchdog.clear() } }
}
