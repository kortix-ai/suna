/**
 * Box resource telemetry — the numbers every "the session stopped"
 * investigation needed and never had on record.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger'
import { evaluateOpenCodePressure, formatOpenCodeMemoryGuardReason, isOpenCodeServeCommand } from '../harness/open-code/resource-diagnostics'
import {
  type ResourceSnapshot,
  cgroupSnapshot,
  evaluatePressure,
  parseLoadavg,
  parseMeminfo,
  parseMemoryConsumer,
  parseProcStatus,
  readResourceSnapshot,
  readTopMemoryProcesses,
  startResourceMonitor,
} from '../resources'

const MEMINFO = `MemTotal:        3985760 kB
MemFree:          123456 kB
MemAvailable:     398576 kB
Buffers:           10000 kB
Shmem:           1999320 kB
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
    cgroup: { currentMb: 1000, workingSetMb: 1000, maxMb: 3000, usedPct: 33, oomKills: 0 },
    disks: [{ path: '/workspace', totalMb: 10000, freeMb: 5000, usedPct: 50 }],
    daemon: { pid: 451, rssMb: 180, threads: 10, state: 'S' },
    runtime: { pid: 2423, rssMb: 2800, threads: 41, state: 'S' },
    runtimePids: [2423],
    ...overrides,
  }
}

describe('parsers', () => {
  test('process attribution keeps RSS but never logs an arbitrary process name', () => {
    expect(parseMemoryConsumer(10, 'Name:\tbun\nVmRSS:\t 1843200 kB\n')).toEqual({ pid: 10, name: 'bun', rssMb: 1800 })
    expect(parseMemoryConsumer(11, 'Name:\tprivate-project\nVmRSS:\t 1024000 kB\n')).toEqual({ pid: 11, name: 'other', rssMb: 1000 })
  })

  test('only the OpenCode executable with serve as its subcommand is counted', () => {
    expect(isOpenCodeServeCommand(['/opt/kortix/bin/opencode', 'serve', '--port', '4096'].join('\0'))).toBe(true)
    expect(isOpenCodeServeCommand('/home/kortix/.bun/bin/bun\0test\0/tmp/opencode/log\0serve\0')).toBe(false)
    expect(isOpenCodeServeCommand('/bin/bash\0-c\0opencode serve\0')).toBe(false)
  })
  test('meminfo → MB and used% from MemAvailable', () => {
    const m = parseMeminfo(MEMINFO)
    expect(m.shmemMb).toBe(1952)
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
      workingSetMb: 1024,
      maxMb: null,
      usedPct: null,
      oomKills: 2,
    })
    expect(cgroupSnapshot('2147483648', '3221225472', null).usedPct).toBe(67)
  })

  // Prod 2026-09-22: `tsc --noEmit` filled the page cache. memory.current read
  // 11315 of 12288 MB (92 %), the guard aborted the turn twice, and anon memory
  // was under 1 GB. The kernel reclaims inactive file pages before it OOM-kills,
  // so used% is the working set: current minus inactive_file.
  test('cgroup v2: used% is the working set, not the reclaimable page cache', () => {
    const current = String(11315 * 1024 * 1024)
    const max = String(12288 * 1024 * 1024)
    const stat = 'anon 891772928\nfile 6053445632\nactive_file 754925568\ninactive_file 5298511872\n'
    expect(cgroupSnapshot(current, max, null, stat)).toEqual({
      currentMb: 11315,
      workingSetMb: 6262,
      maxMb: 12288,
      usedPct: 51,
      oomKills: null,
    })
  })

  test('cgroup v1: total_inactive_file is subtracted', () => {
    const stat = 'cache 100\ntotal_inactive_file 1073741824\n'
    expect(cgroupSnapshot('2147483648', '3221225472', null, stat).usedPct).toBe(33)
  })

  test('no memory.stat: used% falls back to the raw charge', () => {
    expect(cgroupSnapshot('2147483648', '3221225472', null, null)).toMatchObject({ workingSetMb: 2048, usedPct: 67 })
  })
})

describe('formatOpenCodeMemoryGuardReason', () => {
  // Prod 2026-09-24: a 4 GiB Platinum box stopped turns at 99% with OpenCode at
  // 916 MB. The other ~2 GB was a RAM-backed /tmp, and the message never said so.
  test('names RAM-backed files (a tmpfs /tmp) when they hold a large share', () => {
    const s = snapshot({
      memory: { totalMb: 3915, availableMb: 47, usedPct: 99, swapTotalMb: 0, swapFreeMb: 0, shmemMb: 1950 },
      cgroup: { currentMb: null, workingSetMb: null, maxMb: null, usedPct: null, oomKills: null },
      runtime: { pid: 17567, rssMb: 916, threads: 15, state: 'S' },
    })
    expect(formatOpenCodeMemoryGuardReason(s, 99)).toBe(
      'sandbox memory at 99% (opencode 916 MB RSS, 1950 MB in RAM-backed files such as /tmp, of 3915 MB): turn stopped to prevent a kernel OOM kill',
    )
  })
  test('leaves a small shared-memory figure out', () => {
    const s = snapshot({
      memory: { totalMb: 8000, availableMb: 400, usedPct: 95, swapTotalMb: 0, swapFreeMb: 0, shmemMb: 40 },
      cgroup: { currentMb: null, workingSetMb: null, maxMb: null, usedPct: null, oomKills: null },
      runtime: { pid: 1, rssMb: 7440, threads: 8, state: 'R' },
    })
    expect(formatOpenCodeMemoryGuardReason(s, 95)).toBe(
      'sandbox memory at 95% (opencode 7440 MB RSS of 8000 MB): turn stopped to prevent a kernel OOM kill',
    )
  })

  test('names the largest other process without claiming OpenCode used the box', () => {
    const s = snapshot({
      memory: { totalMb: 11961, availableMb: 438, usedPct: 96, swapTotalMb: 0, swapFreeMb: 0 },
      runtime: { pid: 212, rssMb: 674, threads: 24, state: 'S' },
      topProcesses: [
        { pid: 7486, name: 'bun', rssMb: 2800 },
        { pid: 212, name: 'opencode', rssMb: 674 },
      ],
    })
    expect(formatOpenCodeMemoryGuardReason(s, 96)).toContain('largest other process bun 2800 MB RSS')
    expect(formatOpenCodeMemoryGuardReason(s, 96)).toContain('prevent a kernel OOM kill')
  })
})

describe('evaluatePressure', () => {
  test('quiet box → no findings', () => {
    expect(evaluatePressure(snapshot())).toEqual([])
  })

  test('memory, cgroup, disk, load, duplicate opencode, oom-kill rise are each named', () => {
    const s = snapshot({
      memory: { totalMb: 3892, availableMb: 100, usedPct: 97, swapTotalMb: 0, swapFreeMb: 0 },
      cgroup: { currentMb: 2900, workingSetMb: 2900, maxMb: 3000, usedPct: 97, oomKills: 3 },
      disks: [{ path: '/workspace', totalMb: 10000, freeMb: 200, usedPct: 98 }],
      load: [9, 8, 7],
      runtimePids: [2423, 7259],
    })
    const kinds = evaluatePressure(s, snapshot()).map((f) => f.kind).sort()
    expect(kinds).toEqual(['cgroup', 'disk', 'load', 'memory', 'oom-kill', 'runtime-duplicates'])
    const nativeFindings = evaluateOpenCodePressure(s, snapshot())
    expect(nativeFindings.map((f) => f.kind).sort()).toEqual(['cgroup', 'disk', 'load', 'memory', 'oom-kill', 'opencode-duplicates'])
    expect(nativeFindings.find((f) => f.kind === 'opencode-duplicates')?.detail).toBe('2 opencode serve processes: 2423,7259')
  })

  test('null fields never produce findings', () => {
    const s = snapshot({
      memory: { totalMb: null, availableMb: null, usedPct: null, swapTotalMb: null, swapFreeMb: null },
      cgroup: { currentMb: null, workingSetMb: null, maxMb: null, usedPct: null, oomKills: null },
      disks: [{ path: '/x', totalMb: null, freeMb: null, usedPct: null }],
      load: null,
      cpus: null,
      runtimePids: [],
    })
    expect(evaluatePressure(s)).toEqual([])
  })
})

describe('readResourceSnapshot', () => {
  test('top process sampling is bounded and excludes command lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-proc-'))
    try {
      for (const [pid, name, rss] of [[101, 'bun', 2048000], [102, 'private-project', 1024000], [103, 'opencode', 512000]] as const) {
        await mkdir(join(root, String(pid)))
        await writeFile(join(root, String(pid), 'status'), `Name:\t${name}\nVmRSS:\t${rss} kB\n`)
      }
      expect(await readTopMemoryProcesses(root)).toEqual([
        { pid: 101, name: 'bun', rssMb: 2000 },
        { pid: 102, name: 'other', rssMb: 1000 },
        { pid: 103, name: 'opencode', rssMb: 500 },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test('never throws on a host without /proc; disks come from statfs', async () => {
    const s = await readResourceSnapshot({ daemonPid: process.pid, runtimePid: null, diskPaths: ['/', '/definitely/missing'] })
    expect(s.disks).toHaveLength(2)
    expect(s.disks[0]?.totalMb === null || (s.disks[0]?.totalMb as number) > 0).toBe(true)
    expect(s.disks[1]).toEqual({ path: '/definitely/missing', totalMb: null, freeMb: null, usedPct: null })
    expect(s.runtime).toBeNull()
    expect(typeof s.at).toBe('string')
  })
})

describe('startResourceMonitor', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
  })

  test('ticks on start and on demand; pressure warns once per change, not once per tick', async () => {
    let pressured = false
    const warn = spyOn(logger, 'warn')
    try {
      const monitor = startResourceMonitor({
        intervalMs: 60_000,
        runtimePid: () => 2423,
        snapshot: async () =>
          pressured
            ? snapshot({ memory: { totalMb: 3892, availableMb: 100, usedPct: 97, swapTotalMb: 0, swapFreeMb: 0 } })
            : snapshot(),
      })
      stop = monitor.stop
      // The start tick is async; wait for it.
      await Bun.sleep(20)
      expect(monitor.latest()).not.toBeNull()

      pressured = true
      const s = await monitor.tick('diag')
      await monitor.tick('diag')
      expect(s.memory.usedPct).toBe(97)
      expect(monitor.latest()?.memory.usedPct).toBe(97)
      const pressureWarnings = () => warn.mock.calls.filter(([msg]) => msg === '[resources] pressure')
      expect(pressureWarnings()).toHaveLength(1)

      pressured = false
      await monitor.tick('diag')
      pressured = true
      await monitor.tick('diag')
      expect(pressureWarnings()).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
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
      runtimePid: () => 2423,
      snapshot: async () =>
        snapshot({
          memory: { totalMb: 8000, availableMb: Math.round(8000 * (100 - usedPct) / 100), usedPct, swapTotalMb: 0, swapFreeMb: 0 },
          cgroup: { currentMb: null, workingSetMb: null, maxMb: null, usedPct: null, oomKills: null },
          runtime: { pid: 2423, rssMb: Math.round(8000 * usedPct / 100), threads: 8, state: 'R' },
        }),
      guard: {
        formatReason: formatOpenCodeMemoryGuardReason,
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
    expect(aborts[0]).toBe('sandbox memory at 93% (opencode 7440 MB RSS of 8000 MB): turn stopped to prevent a kernel OOM kill')
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
      runtimePid: () => 2423,
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
