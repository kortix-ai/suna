/**
 * Regression coverage for the opencode.ts stop()/restart() fix: opencode is
 * spawned with `detached: true` and killed via the negative pid (the whole
 * process group), not just the direct child. Without that, a grandchild
 * opencode forks (its own `bun install` for the config dir's tool deps) can
 * outlive a restart-triggered SIGTERM and keep writing into a directory a
 * freshly-spawned opencode is installing into concurrently — a real path to
 * a torn/corrupted node_modules that then fails every session's first
 * prompt. These tests exercise the underlying OS-level mechanism directly.
 */
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function spawnWithGrandchild() {
  // The child backgrounds a nested `sh` (the "grandchild"), prints its pid,
  // then waits on it — mirroring opencode forking its own `bun install`.
  const child = spawn('sh', ['-c', 'sh -c "sleep 30" & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    let buf = ''
    child.stdout?.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/(\d+)/)
      if (m) resolve(Number(m[1]))
    })
    child.on('error', reject)
  })
  return { child, grandchildPid }
}

describe('opencode process-group kill', () => {
  test('signaling the process group (detached + -pid) also kills the grandchild', async () => {
    const { child, grandchildPid } = await spawnWithGrandchild()
    expect(isPidAlive(grandchildPid)).toBe(true)

    // This is exactly what opencode.ts's killGroup() does.
    expect(child.pid).toBeTruthy()
    process.kill(-(child.pid as number), 'SIGTERM')

    await waitFor(() => !isPidAlive(grandchildPid))
    expect(isPidAlive(grandchildPid)).toBe(false)
  })

  test('signaling only the direct child (the pre-fix behavior) orphans the grandchild', async () => {
    const { child, grandchildPid } = await spawnWithGrandchild()
    expect(isPidAlive(grandchildPid)).toBe(true)

    child.kill('SIGTERM')
    await waitFor(() => !isPidAlive(child.pid as number))

    // The grandchild survives — this is the orphaned-subprocess race that
    // let a corrupted node_modules install slip through.
    expect(isPidAlive(grandchildPid)).toBe(true)

    process.kill(grandchildPid, 'SIGKILL')
  })
})
