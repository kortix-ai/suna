import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpencodeLifecycle, waitForOpencodeReady } from '../harness/open-code/lifecycle'
import { createOpenCodeHarnessService } from '../harness/open-code/service'

let root: string
let lifecycle: ReturnType<typeof createOpencodeLifecycle> | null

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error('condition did not become true')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-reload-process-'))
  lifecycle = null
})

afterEach(async () => {
  await lifecycle?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('verified reload process promotion', () => {
  test('harness service promotes verified candidates, preserves failed reloads, and restarts through lifecycle', async () => {
    const workspace = join(root, 'workspace')
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    mkdirSync(workspace)
    mkdirSync(configDir)
    writeFileSync(
      binary,
      // Announces itself like real OpenCode: the lifecycle sends a candidate
      // nothing before this line (or its 10 s fallback).
      '#!/usr/bin/env bun\nconst port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1])\nBun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json([]) })\nconsole.log("opencode server listening on http://127.0.0.1:" + port)\n',
    )
    chmodSync(binary, 0o755)

    const primary = reservePort()
    const standby = reservePort()
    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: primary,
      opencodeStandbyPort: standby,
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    const harness = createOpenCodeHarnessService(cfg, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
    })

    lifecycle = harness.native
    await harness.lifecycle.start()
    expect(await waitForOpencodeReady(lifecycle, workspace)).toBe(true)
    const initialPid = lifecycle.getPid()
    expect(initialPid).not.toBeNull()
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)

    const first = await harness.configuration.reloadVerified()
    expect(first.outcome).toBe('swapped')
    if (first.outcome !== 'swapped') throw new Error(first.reason)
    expect(first.port).toBe(standby)
    expect(first.pid).not.toBe(initialPid)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${standby}`)
    await waitFor(() => !processExists(initialPid as number))
    expect((await fetch(`${lifecycle.getInternalUrl()}/session`)).status).toBe(200)
    await Bun.sleep(650)
    expect(lifecycle.getPid()).toBe(first.pid)

    const second = await harness.configuration.reloadVerified()
    expect(second.outcome).toBe('swapped')
    if (second.outcome !== 'swapped') throw new Error(second.reason)
    expect(second.port).toBe(primary)
    expect(second.pid).not.toBe(first.pid)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)
    await waitFor(() => !processExists(first.pid as number))
    await Bun.sleep(650)
    expect(lifecycle.getPid()).toBe(second.pid)

    const activePid = lifecycle.getPid()
    const failed = await harness.configuration.reloadVerified({ forceFail: true })
    expect(failed.outcome).toBe('kept-old')
    expect(lifecycle.getPid()).toBe(activePid)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)
    expect((await fetch(`${lifecycle.getInternalUrl()}/session`)).status).toBe(200)

    // Lifecycle and native features must retain the same method owner. These
    // operations call sibling lifecycle methods through `this` internally.
    await harness.lifecycle.restart()
    expect(await waitForOpencodeReady(lifecycle, workspace)).toBe(true)
    expect(lifecycle.getPid()).not.toBe(activePid)
    expect(harness.lifecycle.getState()).toBe('ok')
    expect((await fetch(`${lifecycle.getInternalUrl()}/session`)).status).toBe(200)
  }, 20_000)
})

describe('the live port is a property of the process, never a variable beside it', () => {
  // Essentia 2026-08-25: the daemon reported `starting` + `opencode_port: 4096`
  // for two hours while its own child (pid 2423) served on 4097. `activePort`
  // had drifted from the process. Now every reader asks the process.
  function fakeOpencode(): { workspace: string; configDir: string; binary: string } {
    const workspace = join(root, 'workspace')
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    mkdirSync(workspace)
    mkdirSync(configDir)
    writeFileSync(
      binary,
      // Announces itself like real OpenCode: the lifecycle sends a candidate
      // nothing before this line (or its 10 s fallback).
      '#!/usr/bin/env bun\nconst port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1])\nBun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json([]) })\nconsole.log("opencode server listening on http://127.0.0.1:" + port)\n',
    )
    chmodSync(binary, 0o755)
    return { workspace, configDir, binary }
  }

  test('reconfigure() with a foreign port pair cannot move the daemon off the port its child serves', async () => {
    const { workspace, configDir, binary } = fakeOpencode()
    const primary = reservePort()
    const standby = reservePort()
    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: primary,
      opencodeStandbyPort: standby,
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    lifecycle = createOpencodeLifecycle(cfg, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
    })
    await lifecycle.start()
    expect(await waitForOpencodeReady(lifecycle, workspace)).toBe(true)

    const swapped = await lifecycle.reloadVerified()
    expect(swapped.outcome).toBe('swapped')
    expect(lifecycle.getActivePort()).toBe(standby)

    // The only code path that rewrites the port variable without touching the
    // process: a config whose pair does not contain the live port.
    lifecycle.reconfigure({ ...cfg, opencodeStandbyPort: reservePort() } as Config)

    expect(lifecycle.getActivePort()).toBe(standby)
    expect(lifecycle.getInternalUrl()).toBe(`http://127.0.0.1:${standby}`)
    expect((await fetch(`${lifecycle.getInternalUrl()}/session`)).status).toBe(200)
    // reconfigure() marks `starting` until the next probe; the probe asks the
    // process's real port, so it comes back `ok` on its own.
    await waitFor(() => lifecycle?.getState() === 'ok', 5_000)
  }, 20_000)

  test('a candidate half that already answers is declined, never "proven" by the incumbent', async () => {
    const { workspace, configDir, binary } = fakeOpencode()
    const primary = reservePort()
    const standby = reservePort()
    const cfg = {
      workspace,
      projectTarget: workspace,
      opencodeInternalPort: primary,
      opencodeStandbyPort: standby,
      gitUserName: 'Kortix Agent',
      gitUserEmail: 'agent@kortix.ai',
    } as Config
    lifecycle = createOpencodeLifecycle(cfg, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
    })
    await lifecycle.start()
    expect(await waitForOpencodeReady(lifecycle, workspace)).toBe(true)
    const livePid = lifecycle.getPid()

    // Something else is already serving the session API on the idle half —
    // the shape a drifted port pair produces (`opencode serve --port <busy>`
    // exits at once with ServeError, so a candidate there is dead on arrival).
    const squatter = Bun.serve({ port: standby, hostname: '127.0.0.1', fetch: () => Response.json([]) })
    try {
      const result = await lifecycle.reloadVerified()
      expect(result.outcome).toBe('kept-old')
      if (result.outcome !== 'kept-old') throw new Error('unreachable')
      expect(result.reason).toContain('already answers')
      expect(lifecycle.getPid()).toBe(livePid)
      expect(processExists(livePid as number)).toBe(true)
      expect(lifecycle.getActivePort()).toBe(primary)
    } finally {
      squatter.stop(true)
    }
  }, 20_000)
})
