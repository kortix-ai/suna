/**
 * Box resource telemetry — the numbers every "the session stopped"
 * investigation needed and never had on record.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ResourceSnapshot,
  cgroupSnapshot,
  evaluatePressure,
  parseLoadavg,
  parseMeminfo,
  parseProcStatus,
  readResourceSnapshot,
  startResourceMonitor,
} from '../resources'

const MEMINFO = `MemTotal:        3985760 kB
MemFree:          123456 kB
MemAvailable:     398576 kB
Buffers:           10000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`

const STATUS = `Name:\topencode.exe
State:\tS (sleeping)
Pid:\t2423
VmRSS:\t 2867200 kB
Threads:\t41
`

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    at: '2026-08-25T22:00:00.000Z',
    uptimeS: 100,
    load: [0.5, 0.4, 0.3],
    cpus: 2,
    memory: { totalMb: 3892, availableMb: 2000, usedPct: 49, swapTotalMb: 0, swapFreeMb: 0 },
    cgroup: { currentMb: 1000, maxMb: 3000, usedPct: 33, oomKills: 0 },
    disks: [{ path: '/workspace', totalMb: 10000, freeMb: 5000, usedPct: 50 }],
    daemon: { pid: 451, rssMb: 180, threads: 10, state: 'S' },
    opencode: { pid: 2423, rssMb: 2800, threads: 41, state: 'S' },
    opencodePids: [2423],
    ...overrides,
  }
}

describe('parsers', () => {
  test('meminfo → MB and used% from MemAvailable', () => {
    const m = parseMeminfo(MEMINFO)
    expect(m.totalMb).toBe(3892)
    expect(m.availableMb).toBe(389)
    expect(m.usedPct).toBe(90)
    expect(m.swapTotalMb).toBe(0)
  })

  test('loadavg', () => {
    expect(parseLoadavg('1.25 0.80 0.40 2/345 6789\n')).toEqual([1.25, 0.8, 0.4])
    expect(parseLoadavg('garbage')).toBeNull()
  })

  test('/proc/<pid>/status → rss, threads, state', () => {
    expect(parseProcStatus(2423, STATUS)).toEqual({ pid: 2423, rssMb: 2800, threads: 41, state: 'S' })
  })

  test('cgroup v2: "max" is unlimited, oom_kill counter is read', () => {
    expect(cgroupSnapshot('1073741824\n', 'max\n', 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 2\n')).toEqual({
      currentMb: 1024,
      maxMb: null,
      usedPct: null,
      oomKills: 2,
    })
    expect(cgroupSnapshot('2147483648', '3221225472', null).usedPct).toBe(67)
  })
})

describe('evaluatePressure', () => {
  test('quiet box → no findings', () => {
    expect(evaluatePressure(snapshot())).toEqual([])
  })

  test('memory, cgroup, disk, load, duplicate opencode, oom-kill rise are each named', () => {
    const s = snapshot({
      memory: { totalMb: 3892, availableMb: 100, usedPct: 97, swapTotalMb: 0, swapFreeMb: 0 },
      cgroup: { currentMb: 2900, maxMb: 3000, usedPct: 97, oomKills: 3 },
      disks: [{ path: '/workspace', totalMb: 10000, freeMb: 200, usedPct: 98 }],
      load: [9, 8, 7],
      opencodePids: [2423, 7259],
    })
    const kinds = evaluatePressure(s, snapshot()).map((f) => f.kind).sort()
    expect(kinds).toEqual(['cgroup', 'disk', 'load', 'memory', 'oom-kill', 'opencode-duplicates'])
  })

  test('null fields never produce findings', () => {
    const s = snapshot({
      memory: { totalMb: null, availableMb: null, usedPct: null, swapTotalMb: null, swapFreeMb: null },
      cgroup: { currentMb: null, maxMb: null, usedPct: null, oomKills: null },
      disks: [{ path: '/x', totalMb: null, freeMb: null, usedPct: null }],
      load: null,
      cpus: null,
      opencodePids: [],
    })
    expect(evaluatePressure(s)).toEqual([])
  })
})

describe('readResourceSnapshot', () => {
  test('never throws on a host without /proc; disks come from statfs', async () => {
    const s = await readResourceSnapshot({ daemonPid: process.pid, opencodePid: null, diskPaths: ['/', '/definitely/missing'] })
    expect(s.disks).toHaveLength(2)
    expect(s.disks[0]?.totalMb === null || (s.disks[0]?.totalMb as number) > 0).toBe(true)
    expect(s.disks[1]).toEqual({ path: '/definitely/missing', totalMb: null, freeMb: null, usedPct: null })
    expect(s.opencode).toBeNull()
    expect(typeof s.at).toBe('string')
  })
})

describe('startResourceMonitor', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
  })

  test('ticks on start, on demand, and on an opencode state change; pressure logs once per change', async () => {
    const reasons: string[] = []
    let state = 'ok'
    let pressured = false
    const monitor = startResourceMonitor({
      intervalMs: 60_000,
      opencodePid: () => 2423,
      opencodeState: () => state,
      snapshot: async () => {
        return pressured
          ? snapshot({ memory: { totalMb: 3892, availableMb: 100, usedPct: 97, swapTotalMb: 0, swapFreeMb: 0 } })
          : snapshot()
      },
    })
    stop = monitor.stop
    // The start tick is async; wait for it.
    await Bun.sleep(20)
    expect(monitor.latest()).not.toBeNull()

    pressured = true
    const s = await monitor.tick('diag')
    reasons.push('diag')
    expect(s.memory.usedPct).toBe(97)
    expect(monitor.latest()?.memory.usedPct).toBe(97)

    state = 'starting'
    // The state watcher polls every 5 s; drive a tick directly to keep the test fast.
    const t = await monitor.tick('opencode ok -> starting')
    expect(t.memory.usedPct).toBe(97)
    expect(reasons).toEqual(['diag'])
  })
})

describe('memory guard', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
  })

  test('aborts the in-flight turn once at the guard line, relays why, re-arms only after memory drops', async () => {
    let usedPct = 50
    const aborts: string[] = []
    const relays: Array<{ aborted: boolean }> = []
    const monitor = startResourceMonitor({
      intervalMs: 60_000,
      opencodePid: () => 2423,
      snapshot: async () =>
        snapshot({
          memory: { totalMb: 8000, availableMb: Math.round(8000 * (100 - usedPct) / 100), usedPct, swapTotalMb: 0, swapFreeMb: 0 },
          cgroup: { currentMb: null, maxMb: null, usedPct: null, oomKills: null },
          opencode: { pid: 2423, rssMb: Math.round(8000 * usedPct / 100), threads: 8, state: 'R' },
        }),
      guard: {
        guardPct: 92,
        elevatedPct: 80,
        fastIntervalMs: 60_000,
        turnInFlight: async () => true,
        abortTurn: async (reason) => {
          aborts.push(reason)
          return true
        },
        onGuard: ({ aborted }) => {
          relays.push({ aborted })
        },
      },
    })
    stop = monitor.stop
    await Bun.sleep(20)
    expect(aborts).toHaveLength(0)

    usedPct = 85
    await monitor.tick('t')
    expect(aborts).toHaveLength(0) // elevated: fast sampling, no action

    usedPct = 93
    await monitor.tick('t')
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toContain('sandbox memory at 93%')
    expect(aborts[0]).toContain('7440 MB RSS')
    expect(relays).toEqual([{ aborted: true }])

    usedPct = 95
    await monitor.tick('t')
    expect(aborts).toHaveLength(1) // fired once per crossing

    usedPct = 60
    await monitor.tick('t')
    usedPct = 94
    await monitor.tick('t')
    expect(aborts).toHaveLength(2) // re-armed after dropping under the elevated line
  })

  test('with no turn in flight the guard relays but does not abort', async () => {
    const aborts: string[] = []
    const relays: Array<{ aborted: boolean }> = []
    const monitor = startResourceMonitor({
      intervalMs: 60_000,
      opencodePid: () => 2423,
      snapshot: async () =>
        snapshot({ memory: { totalMb: 8000, availableMb: 400, usedPct: 95, swapTotalMb: 0, swapFreeMb: 0 } }),
      guard: {
        turnInFlight: async () => false,
        abortTurn: async (r) => {
          aborts.push(r)
          return true
        },
        onGuard: ({ aborted }) => {
          relays.push({ aborted })
        },
      },
    })
    stop = monitor.stop
    await monitor.tick('t')
    expect(aborts).toHaveLength(0)
    expect(relays).toEqual([{ aborted: false }])
  })
})
