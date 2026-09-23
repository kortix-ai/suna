/**
 * A config reload whose composed OpenCode config is byte-identical must NOT
 * dispose OpenCode.
 *
 * `POST /global/dispose` aborts every in-flight turn (OpenCode logs
 * `disposing all instances` then `error=Aborted` on the running message). On
 * 2026-09-22 a pushed KORTIX_LLM_BASE_URL change reloaded OpenCode mid-turn and
 * killed a running tool loop. In proxy mode that value is not in the config at
 * all: OpenCode's provider points at the localhost LLM proxy, and the proxy is
 * retargeted in place. The dispose re-read identical bytes and bought nothing.
 *
 * Behavioural: a real lifecycle, a fake `opencode` binary that records every
 * dispose, and the real config writer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpencodeLifecycle } from '../harness/open-code/lifecycle'

const ENV_NAMES = [
  'KORTIX_LLM_BASE_URL',
  'KORTIX_LLM_PROXY_URL',
  'KORTIX_TOKEN',
  'KORTIX_OPENCODE_MODEL',
  'KORTIX_LLM_CATALOG_FILE',
] as const
const savedEnv: Record<string, string | undefined> = {}

let root: string
let lifecycle: ReturnType<typeof createOpencodeLifecycle> | null

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

async function waitFor(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error('condition did not become true')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-reload-unchanged-'))
  lifecycle = null
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name]
  process.env.KORTIX_LLM_PROXY_URL = 'http://127.0.0.1:4319'
  process.env.KORTIX_LLM_BASE_URL = 'https://tunnel-a.test/v1/llm-gateway/v1'
  process.env.KORTIX_TOKEN = 'kortix_pat_reload_unchanged_test'
  process.env.KORTIX_OPENCODE_MODEL = 'kortix/model-a'
  process.env.KORTIX_LLM_CATALOG_FILE = join(root, 'no-catalog.json')
})

afterEach(async () => {
  await lifecycle?.stop()
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  rmSync(root, { recursive: true, force: true })
})

async function startLifecycle(): Promise<{ disposes: () => number }> {
  const workspace = join(root, 'workspace')
  const configDir = join(root, 'config')
  const binary = join(root, 'opencode')
  const disposeLog = join(root, 'disposes')
  mkdirSync(workspace)
  mkdirSync(configDir)
  writeFileSync(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch: (req) => {
    if (new URL(req.url).pathname === '/global/dispose') {
      appendFileSync(${JSON.stringify(disposeLog)}, 'x')
      return Response.json(true)
    }
    return Response.json([])
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
  lifecycle = createOpencodeLifecycle(cfg, configDir, undefined, {
    binaryPathOverride: binary,
    configPathOverride: join(root, 'runtime-config.json'),
  })
  await lifecycle.start()
  await waitFor(() => lifecycle?.getState() === 'ok')
  return {
    disposes: () => (existsSync(disposeLog) ? readFileSync(disposeLog, 'utf8').length : 0),
  }
}

describe('reloadConfig — identical composed config', () => {
  test('a proxy-mode base URL change does not dispose OpenCode', async () => {
    const { disposes } = await startLifecycle()
    const pid = lifecycle!.getPid()

    process.env.KORTIX_LLM_BASE_URL = 'https://tunnel-b.test/v1/llm-gateway/v1'
    const result = await lifecycle!.reloadConfig()

    expect(result).toEqual({ how: 'unchanged', turnEnded: false })
    expect(disposes()).toBe(0)
    expect(lifecycle!.getPid()).toBe(pid)
  }, 60_000)

  test('a change that moves the composed config still disposes', async () => {
    const { disposes } = await startLifecycle()

    process.env.KORTIX_OPENCODE_MODEL = 'kortix/model-b'
    const result = await lifecycle!.reloadConfig()

    expect(result).toEqual({ how: 'disposed', turnEnded: false })
    expect(disposes()).toBe(1)
  }, 60_000)
})
