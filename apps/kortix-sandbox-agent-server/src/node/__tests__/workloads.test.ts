/**
 * Proves the workload interface fits all three SHIPPED workloads unchanged.
 *
 * This is the gate from docs/specs/2026-08-21-kortixd.md §12 rule 3: if
 * `monitor` or `warm-seed` needed the interface bent to fit, the interface
 * would be wrong and the harness-adapter work must not start.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  createWorkload,
  monitorWorkload,
  sessionWorkload,
  warmSeedWorkload,
} from '../workloads'
import { resetAgentSwapBlockersForTests } from '../../runtime-assets'
import type { StopReason } from '../workload'

beforeEach(() => {
  resetAgentSwapBlockersForTests()
})

describe('workload interface fits all three shipped workloads', () => {
  test('session reports opencode state and blocks a swap during a turn', () => {
    let inFlight = false
    let state: 'ok' | 'starting' | 'down' = 'starting'
    const w = sessionWorkload({
      start: async () => {},
      turnInFlight: () => inFlight,
      opencodeState: () => state,
    })
    expect(w.kind).toBe('session')
    expect(w.health()).toEqual({ state: 'starting' })
    expect(w.busy()).toBe(false)

    state = 'ok'
    inFlight = true
    expect(w.health()).toEqual({ state: 'ok' })
    expect(w.busy()).toBe(true)
  })

  test('monitor never blocks a swap', () => {
    // Deliberate. A monitor box is never idle, so blocking on it would mean it
    // never converges. The runner owns a restart budget and the box epoch makes
    // a superseded boot's events unacceptable, so a swap costs at most a batch.
    const w = monitorWorkload({ start: async () => {} })
    expect(w.kind).toBe('monitor')
    expect(w.busy()).toBe(false)
    expect(w.health().state).toBe('ok')
    expect(w.health().detail).toEqual({ workload: 'monitor' })
  })

  test('warm-seed blocks a swap until capture is ready', () => {
    // Swapping mid-capture aborts it at its budget, and a template whose
    // capture never completes fails every fork of it forever (2026-06-11).
    let ready = false
    const w = warmSeedWorkload({ start: async () => {}, captureReady: () => ready })
    expect(w.busy()).toBe(true)
    expect(w.health().state).toBe('starting')

    ready = true
    expect(w.busy()).toBe(false)
    expect(w.health().state).toBe('ok')
    expect(w.health().detail).toEqual({ workload: 'warm-seed', capture_ready: true })
  })
})

describe('createWorkload contract', () => {
  test('registers a swap blocker so a workload cannot forget to', async () => {
    // The bug this replaces: registerAgentSwapBlocker was called by side effect
    // from whichever module remembered. A workload that forgot had its live
    // work killed by an update swap.
    //
    // Reaching the blocker check requires getting past FOUR earlier exits
    // (nothing-staged, pinned, too-young, turn-in-flight). A version of this
    // test that skipped the staging returned 'nothing-staged' and asserted
    // nothing at all — so the staged binary below is what makes it real.
    const { requestAgentSwapIfIdle } = await import('../../runtime-assets')
    const { createHash } = await import('node:crypto')
    const fsp = await import('node:fs/promises')
    const os = await import('node:os')
    const nodePath = await import('node:path')

    const stateDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'kortix-swap-blocker-'))
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
    await fsp.writeFile(nodePath.join(stateDir, 'agent.next'), bytes)
    await fsp.writeFile(
      nodePath.join(stateDir, 'agent.next.sha256'),
      createHash('sha256').update(bytes).digest('hex'),
    )

    // Object holder, not a bare `let`: TS narrows a local to `null` after the
    // reset assignment and cannot see the callback mutate it.
    const rec: { exited: number | null } = { exited: null }
    // Read through a function so the declared `number | null` survives; reading
    // the property directly lets TS narrow it to `null` after the reset.
    const lastExit = (): number | null => rec.exited
    const swapOpts = {
      agentStateDir: stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      // Recorded, not thrown: requestAgentSwapIfIdle never throws by design, so
      // a throwing exit is swallowed and asserts nothing.
      exit: (code: number) => {
        rec.exited = code
      },
    }

    try {
      // Control: no workload registered -> the swap proceeds and exits 75.
      resetAgentSwapBlockersForTests()
      rec.exited = null
      await requestAgentSwapIfIdle(swapOpts)
      expect(lastExit(), 'with no blocker the swap should proceed').toBe(75)

      // A busy workload must defer it.
      resetAgentSwapBlockersForTests()
      rec.exited = null
      createWorkload({ kind: 'session', start: async () => {}, busy: () => true })
      expect(await requestAgentSwapIfIdle(swapOpts)).toBe('attached')
      expect(lastExit(), 'a busy workload must not be swapped out from under').toBe(null)

      // An idle one must not block it.
      resetAgentSwapBlockersForTests()
      rec.exited = null
      createWorkload({ kind: 'session', start: async () => {}, busy: () => false })
      await requestAgentSwapIfIdle(swapOpts)
      expect(lastExit(), 'an idle workload should not block the swap').toBe(75)
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true })
    }
  })

  test("busy() returning null means CANNOT TELL, and blocks the swap", async () => {
    // The safety rule from runtime-assets.ts, now expressible in the interface:
    // the turn probe returns boolean | null and 'turn-state-unknown' is a
    // distinct verdict from 'turn-in-flight'. A binary busy() forced callers to
    // collapse that, which is the busy-blind class that has cost live turns.
    const { requestAgentSwapIfIdle } = await import('../../runtime-assets')
    const { createHash } = await import('node:crypto')
    const fsp = await import('node:fs/promises')
    const os = await import('node:os')
    const nodePath = await import('node:path')

    const stateDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'kortix-busy-null-'))
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
    await fsp.writeFile(nodePath.join(stateDir, 'agent.next'), bytes)
    await fsp.writeFile(
      nodePath.join(stateDir, 'agent.next.sha256'),
      createHash('sha256').update(bytes).digest('hex'),
    )
    const rec: { exited: number | null } = { exited: null }
    const lastExit = (): number | null => rec.exited
    const swapOpts = {
      agentStateDir: stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code: number) => {
        rec.exited = code
      },
    }
    try {
      resetAgentSwapBlockersForTests()
      createWorkload({ kind: 'session', start: async () => {}, busy: () => null })
      expect(await requestAgentSwapIfIdle(swapOpts)).toBe('attached')
      expect(lastExit(), 'an unknown busy state must never authorise a swap').toBe(null)
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true })
    }
  })

  test('stop() releases the swap blocker so a dead workload cannot veto forever', async () => {
    // The concrete case: a warm seed registers busy = !captureReady(); capture
    // never completes (2026-06-11); the box is later adopted. Without an
    // unregister the seed's blocker answers "busy" for the life of the box and
    // the node never converges again.
    const { requestAgentSwapIfIdle } = await import('../../runtime-assets')
    const { createHash } = await import('node:crypto')
    const fsp = await import('node:fs/promises')
    const os = await import('node:os')
    const nodePath = await import('node:path')

    const stateDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'kortix-unregister-'))
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
    await fsp.writeFile(nodePath.join(stateDir, 'agent.next'), bytes)
    await fsp.writeFile(
      nodePath.join(stateDir, 'agent.next.sha256'),
      createHash('sha256').update(bytes).digest('hex'),
    )
    const rec: { exited: number | null } = { exited: null }
    const lastExit = (): number | null => rec.exited
    const swapOpts = {
      agentStateDir: stateDir,
      uptimeMs: 10 * 60_000,
      turnInFlight: async () => false,
      exit: (code: number) => {
        rec.exited = code
      },
    }
    try {
      resetAgentSwapBlockersForTests()
      const seed = warmSeedWorkload({ start: async () => {}, captureReady: () => false })
      expect(seed.busy()).toBe(true)
      expect(await requestAgentSwapIfIdle(swapOpts)).toBe('attached')
      expect(lastExit()).toBe(null)

      await seed.stop('release')
      rec.exited = null
      await requestAgentSwapIfIdle(swapOpts)
      expect(lastExit(), 'a stopped workload must stop blocking convergence').toBe(75)
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true })
    }
  })

  test('a throwing preflight fails closed, it does not read as a pass', async () => {
    const w = createWorkload({
      kind: 'session',
      start: async () => {},
      busy: () => false,
      preflight: async () => {
        throw new Error('no workspace')
      },
    })
    const result = await w.preflight()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no workspace')
  })

  test('preflight defaults to ok when a workload declares none', async () => {
    const w = createWorkload({ kind: 'monitor', start: async () => {}, busy: () => false })
    expect(await w.preflight()).toEqual({ ok: true })
  })

  test('a throwing health reports unknown rather than 500ing the health route', () => {
    // /kortix/health is the control plane's liveness probe, polled every few
    // seconds on every box. It must never be taken down by a workload.
    const w = createWorkload({
      kind: 'session',
      start: async () => {},
      busy: () => false,
      health: () => {
        throw new Error('boom')
      },
    })
    expect(w.health()).toEqual({ state: null })
  })

  test('a throwing stop does not prevent the rest of a drain', async () => {
    const w = createWorkload({
      kind: 'session',
      start: async () => {},
      busy: () => false,
      stop: async () => {
        throw new Error('stop exploded')
      },
    })
    // Resolves rather than rejecting — shutdown is best-effort by design.
    await w.stop('shutdown' as StopReason)
  })

  test('stop is a no-op when a workload declares none', async () => {
    const w = createWorkload({ kind: 'warm-seed', start: async () => {}, busy: () => false })
    await w.stop('drain' as StopReason)
  })
})
