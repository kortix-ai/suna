/**
 * DEF-DEV-1 — the last moment a swap can still be called off.
 *
 * `reloadVerified` proves a candidate and then retires the incumbent. On dev
 * the candidate boot alone measured ~3.3 s, and the whole build 8.5-15.4 s, so
 * a prompt can arrive after the caller's turn check and before the promotion
 * commits. The promotion then kills the process writing that turn: the client
 * gets `HTTP 503` and the assistant row stays open for ever.
 *
 * `mayPromote` is that last check. It runs AFTER the candidate is proven and
 * BEFORE the live port moves, so a false answer costs the candidate and
 * nothing else: the incumbent keeps its pid, its port, and its turn.
 *
 * Real processes, no mocks: a fake `opencode` binary that serves the session
 * API, exactly as verified-reload-fail-fast.e2e.test.ts uses it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreTestConfigRoot, serveTestConfigDir } from './helpers/boot-link'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { waitForOpencodeReady } from '../harness/open-code/lifecycle'
import { createOpenCodeHarnessService } from '../harness/open-code/service'

let root: string
let stop: (() => Promise<void>) | null = null

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port as number
  server.stop(true)
  return port
}

const FAKE_OPENCODE = `#!/usr/bin/env bun
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
Bun.serve({ port, hostname: '127.0.0.1', fetch: () => Response.json([]) })
console.log('opencode server listening on http://127.0.0.1:' + port)
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-reload-late-turn-'))
})

afterAll(restoreTestConfigRoot)

afterEach(async () => {
  await stop?.()
  stop = null
  rmSync(root, { recursive: true, force: true })
})

/** Does anything answer on this port right now? */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

function configDir(name: string, body: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.jsonc'), body)
  return dir
}

async function harnessOn(dir: string) {
  const workspace = join(root, 'workspace')
  const binary = join(root, 'opencode')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(binary, FAKE_OPENCODE)
  chmodSync(binary, 0o755)
  const cfg = {
    workspace,
    projectTarget: workspace,
    opencodeInternalPort: reservePort(),
    opencodeStandbyPort: reservePort(),
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
  } as Config
  await serveTestConfigDir(dir, join(root, 'boot-store'))
  const harness = createOpenCodeHarnessService(cfg, undefined, {
    binaryPathOverride: binary,
    configPathOverride: join(root, 'runtime-config.json'),
  })
  stop = () => harness.native.stop()
  await harness.lifecycle.start()
  expect(await waitForOpencodeReady(harness.native, workspace)).toBe(true)
  return { harness, cfg, workspace }
}

describe('a turn that starts before the promotion commits keeps its process', () => {
  test('mayPromote:false retires the CANDIDATE and leaves the incumbent untouched', async () => {
    const { harness, cfg, workspace } = await harnessOn(configDir('good', '{}'))
    const pid = harness.native.getPid()
    const livePort = harness.native.getActivePort()
    const standbyPort = livePort === cfg.opencodeInternalPort ? cfg.opencodeStandbyPort : cfg.opencodeInternalPort
    await serveTestConfigDir(configDir('next', '{ "next": true }'), join(root, 'boot-store'))

    let asked = 0
    const result = await harness.configuration.reloadVerified({
      mayPromote: async () => {
        asked += 1
        return false
      },
    })

    // Asked exactly once, after the candidate was proven.
    expect(asked).toBe(1)
    expect(result.outcome).toBe('kept-old')
    expect(result.outcome === 'kept-old' && result.reason).toContain('turn')
    // The incumbent is the SAME process, on the SAME port, still serving.
    expect(harness.native.getPid()).toBe(pid)
    expect(harness.native.getActivePort()).toBe(livePort)
    expect(await answers(livePort)).toBe(true)
    expect(await waitForOpencodeReady(harness.native, workspace)).toBe(true)
    // The candidate is gone: nothing answers on the standby half any more.
    for (let i = 0; i < 40 && (await answers(standbyPort)); i++) await Bun.sleep(100)
    expect(await answers(standbyPort)).toBe(false)
  }, 60_000)

  test('mayPromote:true promotes, so the check never blocks an idle box', async () => {
    const { harness, cfg } = await harnessOn(configDir('good', '{}'))
    const pid = harness.native.getPid()
    const livePort = harness.native.getActivePort()
    await serveTestConfigDir(configDir('next', '{ "next": true }'), join(root, 'boot-store'))

    const result = await harness.configuration.reloadVerified({ mayPromote: async () => true })

    expect(result.outcome).toBe('swapped')
    expect(harness.native.getPid()).not.toBe(pid)
    expect(harness.native.getActivePort()).not.toBe(livePort)
    expect(harness.native.getActivePort()).toBe(
      livePort === cfg.opencodeInternalPort ? cfg.opencodeStandbyPort : cfg.opencodeInternalPort,
    )
  }, 60_000)
})
