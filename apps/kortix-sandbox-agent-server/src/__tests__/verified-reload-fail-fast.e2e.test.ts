/**
 * A verified reload onto a config OpenCode cannot load fails FAST and names
 * the cause, instead of waiting out the 90 s verify budget with a generic
 * "did not start". Real processes: a fake `opencode` binary that reads
 * `OPENCODE_CONFIG_DIR` and answers the way OpenCode 1.18.31 does (measured
 * 2026-09-22): a syntax error in opencode.jsonc makes every directory route
 * answer 400 `ConfigJsonError`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveTestConfigDir } from './helpers/boot-link'
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
import { readFileSync } from 'node:fs'
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
const dir = process.env.OPENCODE_CONFIG_DIR
let config = ''
try { config = readFileSync(dir + '/opencode.jsonc', 'utf8') } catch {}
// A plugin crash at start-up: the process dies before it serves.
if (config.includes('EXIT')) process.exit(3)
Bun.serve({ port, hostname: '127.0.0.1', fetch(req) {
  if (config.includes('BROKEN')) {
    return Response.json({ name: 'ConfigJsonError', data: { path: dir + '/opencode.jsonc',
      message: '\\n--- JSONC Input ---\\n' + config + '\\n--- Errors ---\\nPropertyNameExpected at line 2, column 28\\n   Line 2: x\\n--- End ---' } }, { status: 400 })
  }
  return Response.json([])
} })
console.log('opencode server listening on http://127.0.0.1:' + port)
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-reload-fail-fast-'))
})

afterEach(async () => {
  await stop?.()
  stop = null
  rmSync(root, { recursive: true, force: true })
})

async function harnessOn(configDir: string) {
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
  await serveTestConfigDir(workspace, join(root, 'boot-store'))
  const harness = createOpenCodeHarnessService(cfg, undefined, {
    binaryPathOverride: binary,
    configPathOverride: join(root, 'runtime-config.json'),
  })
  stop = () => harness.native.stop()
  await harness.lifecycle.start()
  expect(await waitForOpencodeReady(harness.native, workspace)).toBe(true)
  return harness
}

function configDir(name: string, body: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.jsonc'), body)
  return dir
}

describe('verified reload fails fast with the cause', () => {
  test('a config error is reported at once, with the file and position', async () => {
    const harness = await harnessOn(configDir('good', '{}'))
    const pid = harness.native.getPid()
    await serveTestConfigDir(configDir('broken', '{\n "a": 1,,, BROKEN {{\n}'), join(root, 'boot-store'))
    const started = Date.now()
    const result = await harness.configuration.reloadVerified()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result).toEqual({
      outcome: 'kept-old',
      reason: 'ConfigJsonError in opencode.jsonc: PropertyNameExpected at line 2, column 28',
      candidateFailed: true,
    })
    expect(harness.native.getPid()).toBe(pid)
  }, 30_000)

  test('a candidate that exits is reported at once, with its exit code', async () => {
    const harness = await harnessOn(configDir('good', '{}'))
    await serveTestConfigDir(configDir('exits', '{ "EXIT": true }'), join(root, 'boot-store'))
    const started = Date.now()
    const result = await harness.configuration.reloadVerified()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result).toEqual({
      outcome: 'kept-old',
      reason: 'the new opencode exited (code 3) before it served',
      candidateFailed: true,
    })
  }, 30_000)
})
