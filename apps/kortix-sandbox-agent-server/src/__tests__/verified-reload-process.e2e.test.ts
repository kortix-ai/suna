import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import { createOpencodeSupervisor, waitForOpencodeReady } from '../opencode'

let root: string
let supervisor: ReturnType<typeof createOpencodeSupervisor> | null

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
  supervisor = null
})

afterEach(async () => {
  await supervisor?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('verified reload process promotion', () => {
  test('promotes each verified candidate and preserves the active process on failure', async () => {
    const workspace = join(root, 'workspace')
    const configDir = join(root, 'config')
    const binary = join(root, 'opencode')
    mkdirSync(workspace)
    mkdirSync(configDir)
    writeFileSync(
      binary,
      '#!/usr/bin/env bun\nconst port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1])\nBun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json([]) })\n',
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
    supervisor = createOpencodeSupervisor(cfg, configDir, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
    })

    await supervisor.start()
    expect(await waitForOpencodeReady(supervisor, workspace)).toBe(true)
    const initialPid = supervisor.getPid()
    expect(initialPid).not.toBeNull()
    expect(supervisor.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)

    const first = await supervisor.reloadVerified()
    expect(first.outcome).toBe('swapped')
    if (first.outcome !== 'swapped') throw new Error(first.reason)
    expect(first.port).toBe(standby)
    expect(first.pid).not.toBe(initialPid)
    expect(supervisor.getInternalUrl()).toBe(`http://127.0.0.1:${standby}`)
    await waitFor(() => !processExists(initialPid as number))
    expect((await fetch(`${supervisor.getInternalUrl()}/session`)).status).toBe(200)
    await Bun.sleep(650)
    expect(supervisor.getPid()).toBe(first.pid)

    const second = await supervisor.reloadVerified()
    expect(second.outcome).toBe('swapped')
    if (second.outcome !== 'swapped') throw new Error(second.reason)
    expect(second.port).toBe(primary)
    expect(second.pid).not.toBe(first.pid)
    expect(supervisor.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)
    await waitFor(() => !processExists(first.pid as number))
    await Bun.sleep(650)
    expect(supervisor.getPid()).toBe(second.pid)

    const activePid = supervisor.getPid()
    const failed = await supervisor.reloadVerified({ forceFail: true })
    expect(failed.outcome).toBe('kept-old')
    expect(supervisor.getPid()).toBe(activePid)
    expect(supervisor.getInternalUrl()).toBe(`http://127.0.0.1:${primary}`)
    expect((await fetch(`${supervisor.getInternalUrl()}/session`)).status).toBe(200)
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
      '#!/usr/bin/env bun\nconst port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1])\nBun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json([]) })\n',
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
    supervisor = createOpencodeSupervisor(cfg, configDir, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
    })
    await supervisor.start()
    expect(await waitForOpencodeReady(supervisor, workspace)).toBe(true)

    const swapped = await supervisor.reloadVerified()
    expect(swapped.outcome).toBe('swapped')
    expect(supervisor.getActivePort()).toBe(standby)

    // The only code path that rewrites the port variable without touching the
    // process: a config whose pair does not contain the live port.
    supervisor.reconfigure({ ...cfg, opencodeStandbyPort: reservePort() } as Config, configDir)

    expect(supervisor.getActivePort()).toBe(standby)
    expect(supervisor.getInternalUrl()).toBe(`http://127.0.0.1:${standby}`)
    expect((await fetch(`${supervisor.getInternalUrl()}/session`)).status).toBe(200)
    // reconfigure() marks `starting` until the next probe; the probe asks the
    // process's real port, so it comes back `ok` on its own.
    await waitFor(() => supervisor?.getState() === 'ok', 5_000)
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
    supervisor = createOpencodeSupervisor(cfg, configDir, undefined, {
      binaryPathOverride: binary,
      configPathOverride: join(root, 'runtime-config.json'),
    })
    await supervisor.start()
    expect(await waitForOpencodeReady(supervisor, workspace)).toBe(true)
    const livePid = supervisor.getPid()

    // Something else is already serving the session API on the idle half —
    // the shape a drifted port pair produces (`opencode serve --port <busy>`
    // exits at once with ServeError, so a candidate there is dead on arrival).
    const squatter = Bun.serve({ port: standby, hostname: '127.0.0.1', fetch: () => Response.json([]) })
    try {
      const result = await supervisor.reloadVerified()
      expect(result.outcome).toBe('kept-old')
      if (result.outcome !== 'kept-old') throw new Error('unreachable')
      expect(result.reason).toContain('already answers')
      expect(supervisor.getPid()).toBe(livePid)
      expect(processExists(livePid as number)).toBe(true)
      expect(supervisor.getActivePort()).toBe(primary)
    } finally {
      squatter.stop(true)
    }
  }, 20_000)
})
