/**
 * Box resource telemetry: memory, cgroup limit, load, disk, process RSS.
 *
 * WHY. Every "the session stopped" investigation on 2026-08-22..25 needed the
 * same numbers and none were on record: was the box out of memory (a 3 GB
 * E2B box OOM-killing a 2.8 GB OpenCode), was the disk full, was the daemon
 * or OpenCode the one growing, what did the load look like when the turn
 * died. The daemon now logs a `[resources]` line on a fixed cadence, logs
 * `[resources] pressure` the moment a threshold is crossed (and once more
 * when it clears), and answers the same snapshot inside `GET /kortix/diag`.
 *
 * Cost. One snapshot is ~8 small reads under /proc and /sys plus two
 * `statfs` calls, all async, all inside try/catch — a field that cannot be
 * read is `null`, never an error. Nothing here can throw at a caller, and the
 * interval timer is unref'd so it never keeps the process alive.
 *
 * Everything that parses text is a pure function on a string so it is
 * testable on macOS, where /proc does not exist.
 */
import { readFile, readdir, statfs } from 'node:fs/promises'
import { logger } from './logger'

export interface MemorySnapshot {
  totalMb: number | null
  availableMb: number | null
  /** 0..100, from MemAvailable; null when either input is missing. */
  usedPct: number | null
  swapTotalMb: number | null
  swapFreeMb: number | null
}

export interface CgroupMemorySnapshot {
  currentMb: number | null
  /** null = unlimited ("max") or unreadable. */
  maxMb: number | null
  usedPct: number | null
  /** cgroup v2 `memory.events` oom_kill counter; v1 has no cheap equivalent. */
  oomKills: number | null
}

export interface DiskSnapshot {
  path: string
  totalMb: number | null
  freeMb: number | null
  usedPct: number | null
}

export interface ProcessSnapshot {
  pid: number
  rssMb: number | null
  threads: number | null
  /** `State:` letter from /proc/<pid>/status (R, S, D, Z, T) */
  state: string | null
}

export interface ResourceSnapshot {
  at: string
  uptimeS: number | null
  load: [number, number, number] | null
  cpus: number | null
  memory: MemorySnapshot
  cgroup: CgroupMemorySnapshot
  disks: DiskSnapshot[]
  daemon: ProcessSnapshot | null
  opencode: ProcessSnapshot | null
  /** Distinct pids on the box whose cmdline mentions opencode: >1 is a finding. */
  opencodePids: number[]
}

const MB = 1024 * 1024

export function parseMeminfo(text: string): MemorySnapshot {
  const kb = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
    return m ? Number(m[1]) : null
  }
  const totalKb = kb('MemTotal')
  const availKb = kb('MemAvailable')
  const toMb = (v: number | null) => (v === null ? null : Math.round(v / 1024))
  const usedPct =
    totalKb !== null && availKb !== null && totalKb > 0
      ? Math.round(((totalKb - availKb) / totalKb) * 100)
      : null
  return {
    totalMb: toMb(totalKb),
    availableMb: toMb(availKb),
    usedPct,
    swapTotalMb: toMb(kb('SwapTotal')),
    swapFreeMb: toMb(kb('SwapFree')),
  }
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/).slice(0, 3).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return [parts[0] as number, parts[1] as number, parts[2] as number]
}

export function parseProcStatus(pid: number, text: string): ProcessSnapshot {
  const rss = text.match(/^VmRSS:\s+(\d+)\s*kB/m)
  const threads = text.match(/^Threads:\s+(\d+)/m)
  const state = text.match(/^State:\s+(\S)/m)
  return {
    pid,
    rssMb: rss ? Math.round(Number(rss[1]) / 1024) : null,
    threads: threads ? Number(threads[1]) : null,
    state: state ? (state[1] as string) : null,
  }
}

export function parseCgroupBytes(text: string | null): number | null {
  if (text === null) return null
  const v = text.trim()
  if (v === '' || v === 'max') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseCgroupOomKills(text: string | null): number | null {
  if (text === null) return null
  const m = text.match(/^oom_kill\s+(\d+)/m)
  return m ? Number(m[1]) : null
}

export function cgroupSnapshot(
  current: string | null,
  max: string | null,
  events: string | null,
): CgroupMemorySnapshot {
  const currentBytes = parseCgroupBytes(current)
  const maxBytes = parseCgroupBytes(max)
  const currentMb = currentBytes === null ? null : Math.round(currentBytes / MB)
  const maxMb = maxBytes === null ? null : Math.round(maxBytes / MB)
  return {
    currentMb,
    maxMb,
    usedPct:
      currentBytes !== null && maxBytes !== null && maxBytes > 0
        ? Math.round((currentBytes / maxBytes) * 100)
        : null,
    oomKills: parseCgroupOomKills(events),
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function diskSnapshot(path: string): Promise<DiskSnapshot> {
  try {
    const s = await statfs(path)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    return {
      path,
      totalMb: Math.round(total / MB),
      freeMb: Math.round(free / MB),
      usedPct: total > 0 ? Math.round(((total - free) / total) * 100) : null,
    }
  } catch {
    return { path, totalMb: null, freeMb: null, usedPct: null }
  }
}

async function processSnapshot(pid: number | null): Promise<ProcessSnapshot | null> {
  if (pid === null || !Number.isFinite(pid) || pid <= 0) return null
  const text = await readText(`/proc/${pid}/status`)
  if (text === null) return { pid, rssMb: null, threads: null, state: null }
  return parseProcStatus(pid, text)
}

/** Pids whose /proc/<pid>/cmdline mentions `opencode`. Linux only; [] elsewhere. */
export async function findOpencodePids(): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const pids: number[] = []
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        const cmd = await readText(`/proc/${e}/cmdline`)
        if (cmd && /opencode/.test(cmd) && /\bserve\b/.test(cmd.replace(/\0/g, ' '))) pids.push(Number(e))
      }),
  )
  return pids.sort((a, b) => a - b)
}

export interface SnapshotInputs {
  daemonPid: number
  opencodePid: number | null
  diskPaths: string[]
}

export async function readResourceSnapshot(inputs: SnapshotInputs): Promise<ResourceSnapshot> {
  const [meminfo, loadavg, uptime, cgCurrent, cgMax, cgEvents, cgV1Usage, cgV1Limit, daemon, opencode, disks, opencodePids] =
    await Promise.all([
      readText('/proc/meminfo'),
      readText('/proc/loadavg'),
      readText('/proc/uptime'),
      readText('/sys/fs/cgroup/memory.current'),
      readText('/sys/fs/cgroup/memory.max'),
      readText('/sys/fs/cgroup/memory.events'),
      readText('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
      readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
      processSnapshot(inputs.daemonPid),
      processSnapshot(inputs.opencodePid),
      Promise.all(inputs.diskPaths.map(diskSnapshot)),
      findOpencodePids(),
    ])
  const cgroup =
    cgCurrent !== null || cgMax !== null
      ? cgroupSnapshot(cgCurrent, cgMax, cgEvents)
      : cgroupSnapshot(cgV1Usage, cgV1Limit, null)
  let cpus: number | null = null
  try {
    cpus = (await import('node:os')).cpus().length || null
  } catch {
    cpus = null
  }
  return {
    at: new Date().toISOString(),
    uptimeS: uptime ? Math.round(Number(uptime.split(/\s+/)[0])) || null : null,
    load: loadavg ? parseLoadavg(loadavg) : null,
    cpus,
    memory: meminfo
      ? parseMeminfo(meminfo)
      : { totalMb: null, availableMb: null, usedPct: null, swapTotalMb: null, swapFreeMb: null },
    cgroup,
    disks,
    daemon,
    opencode,
    opencodePids,
  }
}

export interface PressureFinding {
  kind: 'memory' | 'cgroup' | 'disk' | 'load' | 'opencode-duplicates' | 'oom-kill'
  detail: string
}

export const PRESSURE_THRESHOLDS = {
  memoryUsedPct: 90,
  cgroupUsedPct: 90,
  diskUsedPct: 90,
  /** load1 per cpu */
  loadPerCpu: 4,
}

/** Pure: which thresholds does this snapshot cross? */
export function evaluatePressure(s: ResourceSnapshot, previous?: ResourceSnapshot | null): PressureFinding[] {
  const out: PressureFinding[] = []
  if (s.memory.usedPct !== null && s.memory.usedPct >= PRESSURE_THRESHOLDS.memoryUsedPct) {
    out.push({ kind: 'memory', detail: `box memory ${s.memory.usedPct}% used, ${s.memory.availableMb} MB available` })
  }
  if (s.cgroup.usedPct !== null && s.cgroup.usedPct >= PRESSURE_THRESHOLDS.cgroupUsedPct) {
    out.push({ kind: 'cgroup', detail: `cgroup memory ${s.cgroup.usedPct}% of ${s.cgroup.maxMb} MB limit` })
  }
  for (const d of s.disks) {
    if (d.usedPct !== null && d.usedPct >= PRESSURE_THRESHOLDS.diskUsedPct) {
      out.push({ kind: 'disk', detail: `${d.path} ${d.usedPct}% used, ${d.freeMb} MB free` })
    }
  }
  if (s.load && s.cpus && s.load[0] / s.cpus >= PRESSURE_THRESHOLDS.loadPerCpu) {
    out.push({ kind: 'load', detail: `load1 ${s.load[0]} on ${s.cpus} cpu` })
  }
  if (s.opencodePids.length > 1) {
    out.push({ kind: 'opencode-duplicates', detail: `${s.opencodePids.length} opencode serve processes: ${s.opencodePids.join(',')}` })
  }
  if (
    s.cgroup.oomKills !== null &&
    previous?.cgroup.oomKills !== null &&
    previous?.cgroup.oomKills !== undefined &&
    s.cgroup.oomKills > previous.cgroup.oomKills
  ) {
    out.push({ kind: 'oom-kill', detail: `cgroup oom_kill rose ${previous.cgroup.oomKills} -> ${s.cgroup.oomKills}` })
  }
  return out
}

/**
 * The memory guard: act BEFORE the kernel does.
 *
 * Essentia 2026-08-25 23:12Z: OpenCode reached 6.48 GB RSS on an 8 GB box and
 * the kernel OOM-killed it mid-turn (`dmesg`: `Killed process 1506
 * (opencode.exe) anon-rss:6484532kB`). The assistant message in flight was
 * left as an empty husk, the ledger had to infer an ending, and nothing had
 * said "memory" anywhere the operator could see.
 *
 * Above `elevatedPct` (80) the monitor samples every `fastIntervalMs` (10 s)
 * instead of every minute. At `guardPct` (92) with a turn in flight it calls
 * `abortTurn`: OpenCode ends the turn cleanly (transcript consistent,
 * process alive, a real `session.error`), the box gets its memory back, and
 * `onGuard` tells the control plane why. One guard action per crossing; the
 * next one needs the box to drop below `elevatedPct` first.
 */
export interface MemoryGuardOptions {
  /** 0..100 of box memory (or cgroup, whichever is higher). Default 92. */
  guardPct?: number
  /** Sample fast above this. Default 80. */
  elevatedPct?: number
  fastIntervalMs?: number
  turnInFlight: () => Promise<boolean | null>
  abortTurn: (reason: string) => Promise<boolean>
  onGuard?: (info: { reason: string; snapshot: ResourceSnapshot; aborted: boolean }) => void | Promise<void>
}

export interface ResourceMonitorOptions {
  intervalMs?: number
  diskPaths?: string[]
  opencodePid: () => number | null
  opencodeState?: () => string
  snapshot?: (inputs: SnapshotInputs) => Promise<ResourceSnapshot>
  guard?: MemoryGuardOptions
}

/** The memory figure the guard judges: box used% or cgroup used%, whichever is worse. */
export function memoryPressurePct(s: ResourceSnapshot): number | null {
  const a = s.memory.usedPct
  const b = s.cgroup.usedPct
  if (a === null && b === null) return null
  return Math.max(a ?? 0, b ?? 0)
}

export interface ResourceMonitor {
  stop(): void
  /** The most recent snapshot, or null before the first tick. */
  latest(): ResourceSnapshot | null
  /** Take one now (also logs it). */
  tick(reason: string): Promise<ResourceSnapshot>
}

export const DEFAULT_RESOURCE_INTERVAL_MS = 60_000
export const DEFAULT_DISK_PATHS = ['/workspace', '/opt/kortix', '/tmp']

/**
 * Log a `[resources]` line every `intervalMs` (default 60 s), and a
 * `[resources] pressure` warning when a threshold is first crossed / cleared.
 * Also logs immediately when the OpenCode state string changes, so a
 * `starting`/`down` transition always has the box numbers next to it.
 */
export function startResourceMonitor(opts: ResourceMonitorOptions): ResourceMonitor {
  const intervalMs = opts.intervalMs ?? DEFAULT_RESOURCE_INTERVAL_MS
  const diskPaths = opts.diskPaths ?? DEFAULT_DISK_PATHS
  const snapshot = opts.snapshot ?? readResourceSnapshot
  const guard = opts.guard
  const guardPct = guard?.guardPct ?? 92
  const elevatedPct = guard?.elevatedPct ?? 80
  const fastIntervalMs = guard?.fastIntervalMs ?? 10_000
  let latest: ResourceSnapshot | null = null
  let lastPressureKinds = ''
  let lastState = opts.opencodeState?.() ?? ''
  let ticking = false
  let stopped = false
  let fastTimer: ReturnType<typeof setInterval> | null = null
  /** Armed again only once memory drops below `elevatedPct`. */
  let guardFired = false

  async function runGuard(s: ResourceSnapshot): Promise<void> {
    if (!guard) return
    const pct = memoryPressurePct(s)
    if (pct === null) return
    if (pct < elevatedPct) {
      guardFired = false
      if (fastTimer) {
        clearInterval(fastTimer)
        fastTimer = null
        logger.info('[resources] memory back under the elevated line; slow sampling', { pct })
      }
      return
    }
    if (!fastTimer) {
      logger.warn('[resources] memory elevated; sampling every 10 s', { pct, elevatedPct })
      fastTimer = setInterval(() => void guardedTick('elevated'), fastIntervalMs)
      fastTimer.unref?.()
    }
    if (pct < guardPct || guardFired) return
    guardFired = true
    const inFlight = await guard.turnInFlight().catch(() => null)
    const reason =
      `sandbox memory at ${pct}% (opencode ${s.opencode?.rssMb ?? '?'} MB RSS of ` +
      `${s.cgroup.maxMb ?? s.memory.totalMb ?? '?'} MB): turn stopped before the kernel would kill opencode`
    let aborted = false
    if (inFlight !== false) {
      aborted = await guard.abortTurn(reason).catch(() => false)
    }
    logger.error('[resources] memory guard', { pct, guardPct, inFlight, aborted, reason, ...s })
    try {
      await guard.onGuard?.({ reason, snapshot: s, aborted })
    } catch (err) {
      logger.warn('[resources] memory guard relay failed', { err: (err as Error).message })
    }
  }

  async function tick(reason: string): Promise<ResourceSnapshot> {
    const s = await snapshot({ daemonPid: process.pid, opencodePid: opts.opencodePid(), diskPaths })
    try {
      const findings = evaluatePressure(s, latest)
      const kinds = findings.map((f) => f.kind).sort().join(',')
      logger.info('[resources]', { reason, opencodeState: opts.opencodeState?.() ?? null, ...s })
      if (kinds !== lastPressureKinds) {
        if (findings.length > 0) {
          logger.warn('[resources] pressure', { findings, opencodeState: opts.opencodeState?.() ?? null })
        } else {
          logger.info('[resources] pressure cleared', { previously: lastPressureKinds })
        }
        lastPressureKinds = kinds
      }
    } catch {
      // telemetry must never throw
    }
    latest = s
    try {
      await runGuard(s)
    } catch {
      // the guard is best-effort; never let it break sampling
    }
    return s
  }

  async function guardedTick(reason: string): Promise<void> {
    if (ticking || stopped) return
    ticking = true
    try {
      await tick(reason)
    } catch {
      // never
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(() => void guardedTick('interval'), intervalMs)
  timer.unref?.()
  // State transitions get their own snapshot within 5 s.
  const stateTimer = opts.opencodeState
    ? setInterval(() => {
        const now = opts.opencodeState?.() ?? ''
        if (now !== lastState) {
          const from = lastState
          lastState = now
          void guardedTick(`opencode ${from || '?'} -> ${now}`)
        }
      }, 5_000)
    : null
  stateTimer?.unref?.()
  void guardedTick('start')

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      if (stateTimer) clearInterval(stateTimer)
      if (fastTimer) clearInterval(fastTimer)
    },
    latest: () => latest,
    tick,
  }
}
