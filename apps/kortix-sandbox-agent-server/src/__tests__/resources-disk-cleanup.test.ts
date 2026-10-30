/**
 * The disk-pressure remediation loop: when the box's rootfs crosses the
 * pressure threshold, the daemon acts — it deletes known-safe regenerable
 * caches (package caches, workspace build caches, unreferenced pnpm store
 * objects) and reports what it freed — instead of only logging the pressure
 * while the box drifts to 100% (KRTX-2593: dev VMs sat at 96-100% rootfs
 * with no in-VM remediation at all).
 *
 * The deletes are bounded to a known-safe target set: never the workspace's
 * own files, never `.git`, never anything outside the list.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/lib/log/logger'
import { type DiskSnapshot, type ResourceSnapshot, startResourceMonitor, TMPFS_TYPE } from '@/services/resources/resources'
import { knownSafeTargets, runDiskCleanup } from '@/services/resources/disk-cleanup'

let root: string
let home: string
let ws: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'disk-cleanup-'))
  home = join(root, 'home')
  ws = join(root, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(ws, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function snapshotWithDisk(usedPct: number): ResourceSnapshot {
  return {
    at: '2026-10-17T12:00:00.000Z',
    uptimeS: 100,
    load: [0.5, 0.4, 0.3],
    cpus: 2,
    memory: { totalMb: 3892, availableMb: 2000, usedPct: 49, swapTotalMb: 0, swapFreeMb: 0 },
    cgroup: { currentMb: 1000, workingSetMb: 1000, maxMb: 3000, usedPct: 33, oomKills: 0 },
    disks: [{ path: ws, totalMb: 40000, freeMb: Math.round(40000 * (1 - usedPct / 100)), usedPct }],
    daemon: { pid: 451, rssMb: 180, threads: 10, state: 'S' },
    runtime: { pid: 2423, rssMb: 2800, threads: 41, state: 'S' },
    runtimePids: [2423],
  }
}

/** Seed a directory with one file of `mb` MB (sparse write of repeated bytes). */
async function seed(path: string, mb: number): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'blob'), Buffer.alloc(mb * 1024 * 1024, 1))
}

function startMonitor(usedPct: number) {
  return startResourceMonitor({
    intervalMs: 3_600_000,
    runtimePid: () => null,
    snapshot: async () => snapshotWithDisk(usedPct),
    diskCleanup: { home, workspaceRoot: ws },
  })
}

/** The same fixture with an explicit disk list — the trigger's judged set. */
function startMonitorWithDisks(disks: DiskSnapshot[], snapshotFn?: () => Promise<ResourceSnapshot>) {
  return startResourceMonitor({
    intervalMs: 3_600_000,
    runtimePid: () => null,
    snapshot: snapshotFn ?? (async () => ({ ...snapshotWithDisk(50), disks })),
    diskCleanup: { home, workspaceRoot: ws },
  })
}

const cleanupCalls = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter(([msg]) => msg === '[resources] disk cleanup') as [
    string,
    { usedPct: number; freedMb: number; tier: 1 | 2; cleaned: { path: string; freedMb: number }[] },
  ][]

describe('the remediation loop', () => {
  // The bug: a pressure crossing logged the alarm and nothing else. The
  // seeded caches must be gone and the action logged with what it freed.
  test('a crossing above the disk threshold cleans the tier-1 caches and logs the freed bytes', async () => {
    await seed(join(home, '.cache/uv'), 2)
    await seed(join(home, '.cache/pnpm'), 2)
    await seed(join(ws, 'node_modules/.cache'), 1) // tier 2: must survive at 92%
    await seed(join(ws, 'project'), 1) // session data: always survives
    const warn = spyOn(logger, 'warn')
    const monitor = startMonitor(92)
    try {
      await monitor.tick('test')
      await expect(stat(join(home, '.cache/uv', 'blob'))).rejects.toBeTruthy()
      await expect(stat(join(home, '.cache/pnpm', 'blob'))).rejects.toBeTruthy()
      await expect(readFile(join(ws, 'project', 'blob'))).resolves.toBeTruthy() // untouched
      await expect(readFile(join(ws, 'node_modules/.cache', 'blob'))).resolves.toBeTruthy() // tier 2 survives below 95
      const calls = cleanupCalls(warn)
      const [first] = calls
      expect(first).toBeTruthy()
      expect(first?.[1].tier).toBe(1)
      expect(first?.[1].freedMb).toBeGreaterThanOrEqual(4)
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('a crossing at the deep threshold also prunes unreferenced store objects and build caches', async () => {
    await seed(join(ws, '.turbo/cache'), 1)
    const store = join(home, '.local/share/pnpm/store/v3/files/aa/bb')
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'referenced'), Buffer.alloc(1024 * 1024, 2))
    await mkdir(join(ws, 'node_modules/pkg'), { recursive: true })
    // pnpm links store objects into projects by hardlink, which is what
    // raises nlink above 1 — a symlink would not.
    await link(join(store, 'referenced'), join(ws, 'node_modules/pkg/referenced'))
    await writeFile(join(store, 'unreferenced'), Buffer.alloc(1024 * 1024, 3))
    const warn = spyOn(logger, 'warn')
    const monitor = startMonitor(97)
    try {
      await monitor.tick('test')
      await expect(stat(join(ws, '.turbo/cache', 'blob'))).rejects.toBeTruthy() // tier 2 build cache
      await expect(stat(join(store, 'unreferenced'))).rejects.toBeTruthy() // store object with no hardlink
      await expect(stat(join(store, 'referenced'))).resolves.toBeTruthy() // linked into node_modules: kept
      const calls = cleanupCalls(warn)
      const [first] = calls
      expect(first).toBeTruthy()
      expect(first?.[1].tier).toBe(2)
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('one action per episode: a still-pressured next tick does not clean again', async () => {
    await seed(join(home, '.cache/uv'), 1)
    const warn = spyOn(logger, 'warn')
    const monitor = startMonitor(93)
    try {
      await monitor.tick('a')
      await monitor.tick('b')
      expect(cleanupCalls(warn).length).toBe(1)
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('the loop re-arms once the pressure clears', async () => {
    await seed(join(home, '.cache/uv'), 1)
    const warn = spyOn(logger, 'warn')
    let usedPct = 93
    const monitor = startResourceMonitor({
      intervalMs: 3_600_000,
      runtimePid: () => null,
      snapshot: async () => snapshotWithDisk(usedPct),
      diskCleanup: { home, workspaceRoot: ws },
    })
    try {
      await monitor.tick('first') // acts
      usedPct = 50
      await monitor.tick('cleared') // re-arms, no action
      usedPct = 91
      await seed(join(home, '.cache/uv'), 1) // refilled
      await monitor.tick('second') // acts again
      expect(cleanupCalls(warn).length).toBe(2)
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('never touches anything outside the known-safe set, and a symlinked cache entry never takes its target with it', async () => {
    await seed(join(ws, 'project'), 1)
    await mkdir(join(ws, '.git'), { recursive: true })
    await writeFile(join(ws, '.git', 'config'), 'ref: refs/heads/main')
    await mkdir(join(home, '.local/share/claude'), { recursive: true })
    await writeFile(join(home, '.local/share/claude', 'state'), 'session state')
    await seed(join(home, '.cache/uv'), 1)
    await symlink(join(ws, 'project'), join(home, '.cache/uv', 'escape'))
    const warn = spyOn(logger, 'warn')
    const monitor = startMonitor(93)
    try {
      await monitor.tick('test')
      await expect(readFile(join(ws, 'project', 'blob'))).resolves.toBeTruthy()
      await expect(readFile(join(ws, '.git', 'config'), 'utf8')).resolves.toBe('ref: refs/heads/main')
      await expect(readFile(join(home, '.local/share/claude', 'state'), 'utf8')).resolves.toBe('session state')
      await expect(readFile(join(ws, 'project', 'blob'))).resolves.toBeTruthy() // the symlink target survives
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('the trigger skips a tmpfs disk: a tmpfs crossing fires nothing', async () => {
    await seed(join(home, '.cache/uv'), 1)
    const warn = spyOn(logger, 'warn')
    const monitor = startMonitorWithDisks([
      { path: ws, totalMb: 40000, freeMb: 20000, usedPct: 50 },
      { path: '/tmp', totalMb: 9858, freeMb: 0, usedPct: 100, type: TMPFS_TYPE },
    ])
    try {
      await monitor.tick('test')
      await expect(stat(join(home, '.cache/uv', 'blob'))).resolves.toBeTruthy()
      expect(cleanupCalls(warn).length).toBe(0)
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('the trigger judges the actable fs: a session-fs crossing at 91 fires tier 1 next to a tmpfs disk at 100', async () => {
    await seed(join(home, '.cache/uv'), 1)
    const warn = spyOn(logger, 'warn')
    const monitor = startMonitorWithDisks([
      { path: ws, totalMb: 40000, freeMb: 3600, usedPct: 91 },
      { path: '/tmp', totalMb: 9858, freeMb: 0, usedPct: 100, type: TMPFS_TYPE },
    ])
    try {
      await monitor.tick('test')
      await expect(stat(join(home, '.cache/uv', 'blob'))).rejects.toBeTruthy()
      const [first] = cleanupCalls(warn)
      expect(first?.[1].tier).toBe(1)
      expect(first?.[1].usedPct).toBe(91) // the judged figure, not the tmpfs one
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })

  test('concurrent direct ticks serialize: no interleaved snapshots, and the cleanup acts once', async () => {
    await seed(join(home, '.cache/uv'), 1)
    const warn = spyOn(logger, 'warn')
    const rec: string[] = []
    let usedPct = 50
    const recordingSnapshot = async (): Promise<ResourceSnapshot> => {
      rec.push('in')
      await Promise.resolve()
      rec.push('out')
      return snapshotWithDisk(usedPct)
    }
    const monitor = startResourceMonitor({
      intervalMs: 3_600_000,
      runtimePid: () => null,
      snapshot: recordingSnapshot,
      diskCleanup: { home, workspaceRoot: ws },
    })
    try {
      // Settle the fire-and-forget startup tick, then re-arm at 50 so the
      // two concurrent ticks below are the only acts under recording.
      await monitor.tick('warmup')
      rec.length = 0
      usedPct = 93
      const [a, b] = await Promise.all([monitor.tick('a'), monitor.tick('b')])
      // The second tick waited for the first instead of interleaving with it.
      expect(rec).toEqual(['in', 'out', 'in', 'out'])
      expect(a.disks[0]?.usedPct).toBe(93)
      expect(b.disks[0]?.usedPct).toBe(93) // the direct tick still reports, not skip
      expect(cleanupCalls(warn).length).toBe(1) // once-per-episode holds under queueing
    } finally {
      warn.mockRestore()
      monitor.stop()
    }
  })
})

describe('runDiskCleanup (the unit)', () => {
  test('missing and empty targets are skipped, not errors', async () => {
    const targets = await knownSafeTargets(home, ws)
    const report = await runDiskCleanup(targets, { maxTier: 2 })
    expect(report.freedMb).toBe(0)
    expect(report.cleaned).toEqual([])
  })

  test('skips a target below its tier', async () => {
    await seed(join(ws, '.turbo/cache'), 1)
    const targets = await knownSafeTargets(home, ws)
    const turbo = targets.find((t) => t.path === join(ws, '.turbo/cache'))
    expect(turbo?.tier).toBe(2)
    const report = await runDiskCleanup(targets, { maxTier: 1 })
    expect(report.cleaned.some((c) => c.path === join(ws, '.turbo/cache'))).toBe(false)
    await expect(stat(join(ws, '.turbo/cache', 'blob'))).resolves.toBeTruthy()
  })

  test('the real defaults name the real fleet paths', async () => {
    const targets = await knownSafeTargets(homedir(), '/workspace')
    const paths = targets.map((t) => t.path)
    expect(paths).toContain(join(homedir(), '.cache/uv'))
    expect(paths).toContain(join(homedir(), '.cache/pnpm'))
    expect(paths).toContain(join(homedir(), '.npm/_cacache'))
    expect(paths).toContain(join(homedir(), '.bun/install/cache'))
    expect(paths).toContain('/workspace/node_modules/.cache')
    expect(paths).toContain('/workspace/.turbo/cache')
    expect(paths).toContain('/workspace/.next/cache')
  })
})
