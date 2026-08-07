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
