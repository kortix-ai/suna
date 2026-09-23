/**
 * `/kortix/env` must never reload OpenCode while a turn is in flight.
 *
 * Both reload paths interrupt a running turn: a dispose aborts the in-flight
 * message (OpenCode: `disposing all instances`, then `error=Aborted`), and a
 * respawn kills the process. On 2026-09-22 a KORTIX_LLM_BASE_URL push arrived
 * ~4 s after a steer and disposed OpenCode in the middle of a bash tool loop;
 * the turn failed with MessageAbortedError at tick-6 of 30.
 *
 * The rule: the env values land at once (process env, agent-env.sh, LLM proxy
 * upstream); the OpenCode reload waits until no turn is in flight. An
 * unreadable turn state counts as busy.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import type { Opencode } from '../harness/open-code/lifecycle'
import { createProjectEnvStore } from '../project-env'
import { createEnvRouter } from '../routes/env'
import { createOpenCodeControlService } from '../harness/open-code/control'
import { createOpenCodeQuickQueueInterrupt } from '../harness/open-code/background'

const TEST_TOKEN = 'defer-reload-test-kortix-token-32ch'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-defer-'))
let fileSeq = 0
const savedModel = process.env.KORTIX_OPENCODE_MODEL

afterAll(() => {
  rmSync(TEST_ENV_DIR, { recursive: true, force: true })
  if (savedModel === undefined) delete process.env.KORTIX_OPENCODE_MODEL
  else process.env.KORTIX_OPENCODE_MODEL = savedModel
})

function baseConfig(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'project-1',
    apiUrl: 'http://api.test/v1',
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    compiledBootMode: 'off',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
  }
}

function fakeOpencode(): { opencode: Opencode; calls: Array<{ mustRespawn: boolean }> } {
  const calls: Array<{ mustRespawn: boolean }> = []
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
    reloadConfig: async (opts: { mustRespawn?: boolean } = {}) => {
      calls.push({ mustRespawn: Boolean(opts.mustRespawn) })
      return { how: opts.mustRespawn ? 'restarted' : 'disposed', turnEnded: false }
    },
  } as unknown as Opencode
  return { opencode, calls }
}

function buildApp(opencode: Opencode, turnInFlight: () => Promise<boolean | null>) {
  const cfg = baseConfig()
  const store = createProjectEnvStore({
    KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
    KORTIX_PROJECT_SECRET_NAMES: '',
  } as NodeJS.ProcessEnv)
  const control = createOpenCodeControlService(
    opencode,
    createOpenCodeQuickQueueInterrupt(opencode, cfg),
    { turnInFlight, deferredReloadPollMs: 10 },
  ).bind({ cfg, projectEnv: store, agentEnvFile: join(TEST_ENV_DIR, `agent-env-${fileSeq++}.sh`) })
  return new Hono().route('/kortix/env', createEnvRouter(cfg, control))
}

async function pushModel(app: Hono, model: string) {
  const res = await app.request('/kortix/env', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: 'rev-1',
      env: {},
      names: [],
      opencodeEnv: { KORTIX_OPENCODE_MODEL: model },
      refreshModels: true,
    }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error('condition did not become true')
}

describe('env route — no OpenCode reload while a turn is in flight', () => {
  it('idle box: the reload runs inside the push, as before', async () => {
    const { opencode, calls } = fakeOpencode()
    const app = buildApp(opencode, async () => false)

    const { status, json } = await pushModel(app, 'kortix/idle-model')

    expect(status).toBe(200)
    expect(calls).toEqual([{ mustRespawn: false }])
    expect(json.opencode_reload).toBe('disposed')
    expect(json.opencode_reload_deferred).toBe(false)
  })

  it('busy box: the value lands, the reload waits, then runs once the turn ends', async () => {
    const { opencode, calls } = fakeOpencode()
    let busy = true
    const app = buildApp(opencode, async () => busy)

    const { status, json } = await pushModel(app, 'kortix/busy-model')

    expect(status).toBe(200)
    expect(process.env.KORTIX_OPENCODE_MODEL).toBe('kortix/busy-model')
    expect(json.opencode_env_changed).toBe(true)
    expect(json.opencode_reload).toBeNull()
    expect(json.opencode_reload_deferred).toBe(true)
    await Bun.sleep(50)
    expect(calls).toEqual([])

    busy = false
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([{ mustRespawn: false }])
    await Bun.sleep(50)
    expect(calls).toHaveLength(1)
  })

  it('unreadable turn state counts as busy', async () => {
    const { opencode, calls } = fakeOpencode()
    let state: boolean | null = null
    const app = buildApp(opencode, async () => state)

    const { json } = await pushModel(app, 'kortix/unreadable-model')

    expect(json.opencode_reload_deferred).toBe(true)
    await Bun.sleep(50)
    expect(calls).toEqual([])
    state = false
    await waitFor(() => calls.length === 1)
  })

  it('a later push on an idle box flushes a pending reload immediately', async () => {
    const { opencode, calls } = fakeOpencode()
    let busy = true
    const app = buildApp(opencode, async () => busy)
    await pushModel(app, 'kortix/first-model')
    expect(calls).toEqual([])

    busy = false
    // Same value again: no new delta, but the pending reload must not be lost
    // or wait for the poller.
    const { json } = await pushModel(app, 'kortix/first-model')

    expect(json.opencode_reload).toBe('disposed')
    expect(calls).toEqual([{ mustRespawn: false }])
    await Bun.sleep(50)
    expect(calls).toHaveLength(1)
  })
})
