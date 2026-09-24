import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpencodeLifecycle } from '../harness/open-code/lifecycle'

const MAIN = await Bun.file(new URL('../harness/open-code/boot.ts', import.meta.url).pathname).text()

let root: string
let lifecycle: ReturnType<typeof createOpencodeLifecycle> | null

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

/**
 * Every step this gates is a REAL process transition — spawn, SIGKILL, respawn,
 * then an HTTP readiness probe. 5_000 ms was too tight for that on a loaded
 * runner: the packages lane runs this suite with `--parallel=4 --isolate`
 * alongside the other package suites, and on run 35305122951 the final wait
 * expired 19 ms BEFORE `[opencode] ready` was logged — a correct respawn
 * reported as a failure, twice in a row, at 5_340 ms.
 *
 * The invariant these waits sequence is `reports === 1` (the first ready
 * response is reported exactly once), which is timing-independent; the deadline
 * only decides how long we tolerate a slow machine. The learnings register's
 * rule is a 5x margin over the observed event, so budget 25 s per wait against
 * an observed ~5 s, and raise the test's own cap to fit three of them.
 */
async function waitFor(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error('condition did not become true')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-first-ready-response-'))
  lifecycle = null
})

afterEach(async () => {
  await lifecycle?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode lifecycle first ready response', () => {
  test('keeps readiness pending across asynchronous spawn errors and later recovery', async () => {
    const workspace = join(root, 'workspace')
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode-missing-at-first')
    mkdirSync(workspace)
    mkdirSync(configDir)

    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: reservePort(),
      opencodeStandbyPort: reservePort(),
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    let spawnAttempts = 0
    let readySettled = false
    lifecycle = createOpencodeLifecycle(cfg, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
      onStartupMark: (label) => {
        if (label === 'runtime-config-ready') spawnAttempts += 1
      },
      onFirstReadyResponse: () => {
        readySettled = true
      },
    })

    await lifecycle.start()

    await waitFor(() => spawnAttempts >= 2, 3_000)
    expect(readySettled).toBe(false)
    expect(lifecycle.getPid()).toBeNull()

    writeFileSync(
      binary,
      `#!/usr/bin/env bun
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
Bun.serve({ port, hostname: '127.0.0.1', fetch: () => Response.json([]) })
// Real OpenCode announces itself once its handler is attached; the supervisor
// sends nothing before this line (or its 10 s fallback).
console.log('opencode server listening on http://127.0.0.1:' + port)
`,
    )
    chmodSync(binary, 0o755)

    await waitFor(() => readySettled)
    await waitFor(() => lifecycle?.getState() === 'ok')
    expect(spawnAttempts).toBeGreaterThanOrEqual(3)
  }, 15_000)

  test('reports the first successful readiness response once', async () => {
    const workspace = join(root, 'workspace')
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    const readyFile = join(root, 'ready')
    const probedFile = join(root, 'probed')
    mkdirSync(workspace)
    mkdirSync(configDir)
    writeFileSync(
      binary,
      `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs'
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch: () => {
    writeFileSync(${JSON.stringify(probedFile)}, 'probed')
    return existsSync(${JSON.stringify(readyFile)})
      ? Response.json([])
      : new Response('starting', { status: 503 })
  },
})
console.log('opencode server listening on http://127.0.0.1:' + port)
`,
    )
    chmodSync(binary, 0o755)

    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: reservePort(),
      opencodeStandbyPort: reservePort(),
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    let reports = 0
    lifecycle = createOpencodeLifecycle(cfg, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
      onFirstReadyResponse: () => {
        reports += 1
      },
    })

    await lifecycle.start()
    await waitFor(() => existsSync(probedFile))
    expect(reports).toBe(0)

    await Bun.sleep(25)
    expect(reports).toBe(0)

    writeFileSync(readyFile, 'ready')
    await waitFor(() => reports === 1)
    await waitFor(() => lifecycle?.getState() === 'ok')

    rmSync(readyFile)
    await lifecycle.restart()
    writeFileSync(readyFile, 'ready')
    await waitFor(() => lifecycle?.getState() === 'ok')
    expect(reports).toBe(1)

    rmSync(readyFile)
    const livePid = lifecycle.getPid()
    expect(livePid).not.toBeNull()
    process.kill(livePid as number, 'SIGKILL')
    await waitFor(() => lifecycle?.getPid() === null)

    writeFileSync(readyFile, 'ready')
    await waitFor(() => lifecycle?.getState() === 'ok')
    expect(reports).toBe(1)
  }, 90_000)

  test('wires the first ready response to its own de-duplicated boot mark', () => {
    const harnessAt = MAIN.indexOf('const harness = createOpenCodeHarnessService(')
    const sessionRuntimeAt = MAIN.indexOf('void startSessionRuntime(', harnessAt)
    const bootPath = MAIN.slice(harnessAt, sessionRuntimeAt)
    const callbackAt = bootPath.indexOf('onFirstReadyResponse: () => {')
    const nextOptionAt = bootPath.indexOf('deferDirectoryProbe:', callbackAt)
    const callback = bootPath.slice(callbackAt, nextOptionAt)

    expect(harnessAt).toBeGreaterThan(-1)
    expect(sessionRuntimeAt).toBeGreaterThan(harnessAt)
    expect(callbackAt).toBeGreaterThan(-1)
    expect(nextOptionAt).toBeGreaterThan(callbackAt)
    expect(callback).toContain("mark.label === 'opencode-session-api-ready'")
    expect(callback).toContain("bootMark('opencode-session-api-ready')")
    expect(callback).not.toContain('opencode-listening')
  })
})
