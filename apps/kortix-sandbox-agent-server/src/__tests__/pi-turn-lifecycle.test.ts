/**
 * The pi runtime's turn lifecycle, black-box through the daemon's HTTP surface: what
 * "a turn is running" means (`busy()`, the reaper's turn probe), a Stop that a tool
 * ignores, and a runtime that fails to start at boot.
 *
 * pi runs its real model path against a local OpenAI-compatible fake (`Bun.serve`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadConfig } from '@/harness/harness'
import { buildDaemonApp } from '@/app/server'
import { requirePiConfig } from '@/harness/pi/config'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { BOOT_START_RETRY_DELAYS_MS, startRuntimeAtBoot } from '@/harness/pi/boot'
import type { PiBootState } from '@/harness/pi/boot-state'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { signTestUserContext } from './helpers/daemon-test-app'

const TOKEN = 'pi-lifecycle-token'
const MODEL_ID = 'test-model'

type Step = { text: string } | { tool: string; args: Record<string, unknown> } | { stall: true }

function startFakeGateway() {
  let script: Step[] = []
  let calls = 0
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        return Response.json({ models: { [MODEL_ID]: { name: 'Test Model', limit: { context: 64_000, output: 4_096 } } } })
      }
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      await req.json()
      calls += 1
      const step = script.shift() ?? { text: '' }
      if ('stall' in step) {
        return new Promise<Response>((resolve) => req.signal.addEventListener('abort', () => resolve(new Response('aborted', { status: 499 })), { once: true }))
      }
      let body = chunk({ role: 'assistant', content: '' })
      if ('tool' in step) {
        body += chunk({ tool_calls: [{ index: 0, id: `call_${calls}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] })
        body += chunk({}, 'tool_calls')
      } else {
        if (step.text) body += chunk({ content: step.text })
        body += chunk({}, 'stop')
      }
      body += `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      body += 'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1/llm`,
    calls: () => calls,
    script: (steps: Step[]) => {
      script = [...steps]
    },
    stop: () => server.stop(true),
  }
}

interface Rig {
  service: PiHarnessService
  bootState: PiBootState
  workspace: string
  user: (path: string, init?: RequestInit) => Promise<Response>
  bearer: (path: string, init?: RequestInit) => Promise<Response>
}

let gateway: ReturnType<typeof startFakeGateway>
const rigs: Rig[] = []
const saved: Record<string, string | undefined> = {}
const absent = join(tmpdir(), 'pi-lifecycle-absent')

beforeAll(() => {
  gateway = startFakeGateway()
})
afterAll(() => gateway.stop())
beforeEach(() => {
  resetKortixEventBusForTests()
  for (const name of ['HOME', 'KORTIX_MANAGED_SKILLS_DIR', 'KORTIX_PT_ENV_PATH']) saved[name] = process.env[name]
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pi-lifecycle-home-'))
  process.env.KORTIX_MANAGED_SKILLS_DIR = absent
  process.env.KORTIX_PT_ENV_PATH = absent
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.service.lifecycle.stop().catch(() => {})
    rmSync(rig.workspace, { recursive: true, force: true })
  }
  rmSync(process.env.HOME!, { recursive: true, force: true })
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetKortixEventBusForTests()
})

async function boot(input: { script: Step[]; env?: Record<string, string>; prepare?: (workspace: string) => void; start?: boolean }): Promise<Rig> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-lifecycle-'))
  input.prepare?.(workspace)
  gateway.script(input.script)
  const env: NodeJS.ProcessEnv = {
    KORTIX_HARNESS: 'pi',
    KORTIX_LLM_BASE_URL: gateway.baseUrl,
    KORTIX_PI_STATE_DIR: join(workspace, '.state'),
    KORTIX_PI_AGENT_DIR: join(workspace, '.pi-agent'),
    KORTIX_PI_PACKAGES_DIR: join(workspace, '.pi-packages'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: TOKEN,
    KORTIX_SESSION_ID: 'sess-lifecycle',
    KORTIX_PROJECT_ID: 'proj-lifecycle',
    KORTIX_PI_TURN_RETRY_BASE_MS: '5',
    ...input.env,
  }
  const cfg = requirePiConfig(loadConfig(env))
  const service = createPiHarnessService(cfg, undefined, { env })
  const bootState: PiBootState = { repoMaterializationError: null, timeline: [], initialRuntimeSessionRequired: false }
  if (input.start !== false) await service.lifecycle.start()
  const app = buildDaemonApp(cfg, service, Date.now(), bootState)
  const ctx = signTestUserContext({ userId: 'u1', sandboxId: 's1', sandboxRole: 'owner' }, TOKEN)
  const request = (path: string, init: RequestInit, headers: Record<string, string>) =>
    Promise.resolve(app.request(path, { ...init, headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) } }))
  const rig: Rig = {
    service,
    bootState,
    workspace,
    user: (path, init = {}) => request(path, init, { 'X-Kortix-User-Context': ctx }),
    bearer: (path, init = {}) => request(path, init, { Authorization: `Bearer ${TOKEN}` }),
  }
  rigs.push(rig)
  return rig
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

const prompt = (r: Rig, text: string) =>
  r.user(`/session/${r.service.runtime()!.rootId}/prompt_async`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text }] }) })
const turnProbe = async (r: Rig) => (await r.bearer('/kortix/health?turn=1').then((res) => res.json())) as { turn_in_flight: boolean }

async function settle(r: Rig, text: string): Promise<void> {
  const calls = gateway.calls()
  expect((await prompt(r, text)).status).toBe(204)
  await waitFor(() => gateway.calls() > calls && !r.service.runtime()!.busy())
}

describe('pi turn lifecycle: busy is the turn queue, not the last status frame', () => {
  test('a /summarize compaction is work in flight: busy, and the turn probe says so', async () => {
    const r = await boot({
      script: [{ text: 'first answer' }, { text: 'second answer' }, { stall: true }],
      env: { KORTIX_PI_CONTEXT: 'summary' },
      prepare: (workspace) => {
        mkdirSync(join(workspace, '.pi-agent'), { recursive: true })
        writeFileSync(join(workspace, '.pi-agent/settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }))
      },
    })
    const rt = r.service.runtime()!
    await settle(r, 'ALPHA question')
    await settle(r, 'BETA question')
    const calls = gateway.calls()
    expect((await r.user(`/session/${rt.rootId}/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
    // The summary's model call is in flight (the fake stalls it).
    await waitFor(() => gateway.calls() > calls)
    expect(rt.busy()).toBe(true)
    expect(rt.idle()).toBe(false)
    expect((await turnProbe(r)).turn_in_flight).toBe(true)
    expect((await r.user(`/session/${rt.rootId}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => !rt.busy())
    expect((await turnProbe(r)).turn_in_flight).toBe(false)
  })

  test("a session.status idle frame inside a running turn (pi's agent_end) does not end busy", async () => {
    const r = await boot({ script: [{ stall: true }] })
    const rt = r.service.runtime()!
    expect((await prompt(r, 'answer slowly')).status).toBe(204)
    await waitFor(() => gateway.calls() > 0)
    rt.publish({ type: 'session.status', properties: { sessionID: rt.rootId, status: { type: 'idle' } } })
    expect(rt.busy()).toBe(true)
    expect(rt.sessionStatus()).toEqual({ type: 'busy' })
    expect((await turnProbe(r)).turn_in_flight).toBe(true)
    await rt.abort()
    await waitFor(() => !rt.busy())
    expect(rt.sessionStatus()).toEqual({ type: 'idle' })
  })
})

describe('pi turn lifecycle: Stop is bounded', () => {
  // A project tool whose `execute` never settles and never reads its abort signal.
  const HANG = `export default {
  description: 'Wait forever.',
  parameters: { type: 'object', properties: {} },
  execute: () => new Promise(() => {}),
}
`
  const hanging = {
    KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: {} }, project_tools: { hang: 'tools/hang.ts' } }),
    KORTIX_PI_STOP_SETTLE_MS: '150',
  }
  const writeHang = (workspace: string) => {
    mkdirSync(dirname(join(workspace, 'tools/hang.ts')), { recursive: true })
    writeFileSync(join(workspace, 'tools/hang.ts'), HANG)
  }

  test('Stop during a tool that ignores the abort returns at the bound; a restart runs the next prompt', async () => {
    const r = await boot({ script: [{ tool: 'hang', args: {} }, { text: 'after restart' }], env: hanging, prepare: writeHang })
    const rt = r.service.runtime()!
    expect((await prompt(r, 'call the hang tool')).status).toBe(204)
    await waitFor(() => gateway.calls() > 0)
    await Bun.sleep(50)
    expect(rt.busy()).toBe(true)

    const startedAt = Date.now()
    expect((await r.user(`/session/${rt.rootId}/abort`, { method: 'POST' })).status).toBe(200)
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    // The runtime stop lets go of the work it cannot end, so a restart is not wedged behind it.
    const stopAt = Date.now()
    await r.service.lifecycle.restart()
    expect(Date.now() - stopAt).toBeLessThan(2_000)
    const next = r.service.runtime()!
    expect(next.busy()).toBe(false)
    await settle(r, 'are you there?')
    expect(next.busy()).toBe(false)
  })
})

describe('pi turn lifecycle: a failed start at boot', () => {
  test('retries, then records a terminal error that readiness reports by name', async () => {
    const sleeps: number[] = []
    const sleep = spyOn(Bun, 'sleep').mockImplementation((async (ms: number | Date) => {
      sleeps.push(Number(ms))
    }) as typeof Bun.sleep)
    try {
      const r = await boot({ script: [], start: false })
      let attempts = 0
      const lifecycle = {
        start: async () => {
          attempts += 1
          throw new Error('extension load failed')
        },
      }
      expect(await startRuntimeAtBoot(lifecycle, r.bootState)).toBe(false)
      expect(attempts).toBe(BOOT_START_RETRY_DELAYS_MS.length + 1)
      expect(sleeps).toEqual([...BOOT_START_RETRY_DELAYS_MS])
      expect(r.bootState.runtimeStartError).toBe('extension load failed')
      // A request the runtime would serve reads the terminal reason, not a start still in progress.
      const blocked = await r.user('/session')
      expect(blocked.status).toBe(503)
      const body = await blocked.text()
      expect(body).toContain('runtime_start_failed')
      expect(body).toContain('extension load failed')
      expect(body).not.toContain('pi_not_ready')
    } finally {
      sleep.mockRestore()
    }
  })

  test('a start that fails once and then succeeds clears the error', async () => {
    const sleep = spyOn(Bun, 'sleep').mockImplementation((async () => {}) as typeof Bun.sleep)
    try {
      const r = await boot({ script: [], start: false })
      let attempts = 0
      const lifecycle = {
        start: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('catalog fetch failed')
          await r.service.lifecycle.start()
        },
      }
      expect(await startRuntimeAtBoot(lifecycle, r.bootState)).toBe(true)
      expect(r.bootState.runtimeStartError).toBeNull()
      expect(r.service.runtime()?.getState()).toBe('ok')
    } finally {
      sleep.mockRestore()
    }
  })
})
