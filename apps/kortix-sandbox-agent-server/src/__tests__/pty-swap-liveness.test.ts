/**
 * DEF-D 2026-09-26 — a PTY nobody is watching must not block the agent swap
 * forever.
 *
 * Real box, `pty` blocker firing on every single reconcile for hours:
 * `uptime_s: 2663144` (30.8 days). A Platinum box is suspended and resumed
 * rather than rebooted, so boot-only logic never re-runs there — that box
 * therefore never gains `config.release.v1` and never will, as long as
 * `registerAgentSwapBlocker('pty', ...)` (proxy.ts:240) treats every
 * `status: 'running'` entry as live work, regardless of whether anyone is
 * attached or the shell has produced a byte in weeks.
 *
 * The fix: a running pty with no attached viewer AND no activity for
 * {@link PTY_ABANDONED_AFTER_MS} is abandoned, not live work — it no longer
 * blocks the swap. A pty that keeps producing output (a tailed log, a running
 * build) keeps resetting its own clock and stays protected for as long as it
 * is genuinely doing something. An attached viewer always blocks it,
 * regardless of the clock — someone is looking at it right now.
 */
import { describe, expect, test } from 'bun:test'
import {
  createPtyRegistry,
  PTY_ABANDONED_AFTER_MS,
  ptyHasLiveWork,
  ptyIsAbandoned,
  type KortixPtyMeta,
} from '@/routes/kortix/pty'
import type { Config } from '@/lib/config/config'

function meta(over: Partial<KortixPtyMeta> = {}): KortixPtyMeta {
  return {
    id: 'kpty_1',
    title: 'bash',
    command: 'bash',
    args: [],
    cwd: '/workspace',
    status: 'running',
    pid: 123,
    attachedViewers: 0,
    idleMs: 0,
    ...over,
  }
}

describe('ptyIsAbandoned — the bound itself', () => {
  test('an exited pty is never live work', () => {
    expect(ptyIsAbandoned(meta({ status: 'exited', idleMs: 10 ** 9 }))).toBe(true)
  })

  test('a fresh pty with no viewer is NOT abandoned — nobody has had time to attach yet', () => {
    expect(ptyIsAbandoned(meta({ attachedViewers: 0, idleMs: 0 }))).toBe(false)
  })

  test('an attached viewer blocks it no matter how idle the shell has been', () => {
    expect(ptyIsAbandoned(meta({ attachedViewers: 1, idleMs: PTY_ABANDONED_AFTER_MS * 100 }))).toBe(false)
  })

  test('no viewer AND silent past the threshold: abandoned', () => {
    expect(ptyIsAbandoned(meta({ attachedViewers: 0, idleMs: PTY_ABANDONED_AFTER_MS }))).toBe(true)
    expect(ptyIsAbandoned(meta({ attachedViewers: 0, idleMs: PTY_ABANDONED_AFTER_MS - 1 }))).toBe(false)
  })

  test('a long-running background job (output resets the clock) is not abandoned', () => {
    // idleMs is measured from the last broadcast — a process still writing
    // output is, by construction, never at idleMs >= threshold.
    expect(ptyIsAbandoned(meta({ attachedViewers: 0, idleMs: 5_000 }))).toBe(false)
  })
})

describe('ptyHasLiveWork — what the swap blocker actually asks', () => {
  test('empty registry: no live work', () => {
    expect(ptyHasLiveWork([])).toBe(false)
  })

  test('one abandoned pty among running entries: still no live work', () => {
    const entries = [
      meta({ id: 'a', status: 'exited' }),
      meta({ id: 'b', attachedViewers: 0, idleMs: PTY_ABANDONED_AFTER_MS + 1 }),
    ]
    expect(ptyHasLiveWork(entries)).toBe(false)
  })

  test('one attached pty among abandoned ones: live work', () => {
    const entries = [
      meta({ id: 'a', attachedViewers: 0, idleMs: PTY_ABANDONED_AFTER_MS + 1 }),
      meta({ id: 'b', attachedViewers: 1, idleMs: 0 }),
    ]
    expect(ptyHasLiveWork(entries)).toBe(true)
  })
})

describe('the real registry reports attachedViewers and idleMs', () => {
  function cfg(): Config {
    return { workspace: '/tmp' } as unknown as Config
  }

  test('a freshly created pty: zero viewers, near-zero idle, running', async () => {
    const registry = createPtyRegistry(cfg())
    const created = registry.create({ command: 'sh', args: ['-c', 'sleep 5'] })
    try {
      const entry = registry.list()[0]
      if (!entry) throw new Error('expected one pty entry')
      expect(entry.id).toBe(created.id)
      expect(entry.status).toBe('running')
      expect(entry.attachedViewers).toBe(0)
      expect(entry.idleMs).toBeLessThan(1_000)
      expect(ptyHasLiveWork(registry.list())).toBe(true) // too fresh to be abandoned
    } finally {
      registry.remove(created.id)
    }
  })

  test('attach, then detach: attachedViewers goes 0 → 1 → 0, and the pty keeps running', async () => {
    const registry = createPtyRegistry(cfg())
    const created = registry.create({ command: 'sh', args: ['-c', 'sleep 5'] })
    try {
      expect(registry.list()[0]?.attachedViewers).toBe(0)
      const handle = registry.attach(created.id, { onData: () => {}, onExit: () => {} })
      expect(handle).not.toBeNull()
      expect(registry.list()[0]?.attachedViewers).toBe(1)
      handle?.detach()
      expect(registry.list()[0]?.attachedViewers).toBe(0)
      expect(registry.list()[0]?.status).toBe('running')
    } finally {
      registry.remove(created.id)
    }
  })

  test('output resets idleMs to ~0', async () => {
    const registry = createPtyRegistry(cfg())
    const created = registry.create({ command: 'sh', args: ['-c', 'sleep 0.2 && echo hi && sleep 5'] })
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const entry = registry.list().find((e) => e.id === created.id)
      expect(entry?.idleMs).toBeLessThan(1_000)
    } finally {
      registry.remove(created.id)
    }
  })
})
