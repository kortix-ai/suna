/**
 * Regression for the 2026-09-29 incident: v0.13.42 pushed
 * `KORTIX_SECRET_CAPABILITIES` fleet-wide via `/kortix/env`. The route forced
 * a respawn (`mustRespawn`) with no turn check at all — unlike the
 * agent-swap path (`runtime-assets.ts`) and the config-release path
 * (`config-release.ts`), which both defer on `turn-in-flight`. A turn
 * accepted 200ms before the SIGTERM was orphaned for hours.
 *
 * Fix: `applyEnvironment` always supplies `mayPromote` on a `mustRespawn`
 * reload — the LAST check `reloadVerified` makes before the live port moves
 * — and defers to the box's own `session.idle` frame when it declines.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenCodeConfig as Config } from '@/harness/open-code/config'
import type { Opencode, ReloadConfigResult } from '@/harness/open-code/lifecycle'
import { createProjectEnvStore } from '@/services/sandbox-env/project-env'
import { Hono } from 'hono'
import { createEnvRouter } from '@/routes/kortix/env'
import {
  createOpenCodeControlService,
  resetOpencodeEnvRestartPendingForTests,
  opencodeEnvRestartIsPendingForTests,
  retryDeferredOpencodeEnvRestart,
} from '@/harness/open-code/control'
import { resetConfigReleaseStateForTests } from '@/harness/open-code/config-release'
import { createOpenCodeQuickQueueInterrupt } from '@/harness/open-code/background'
import { writeOpenCodeSessionPin } from '@/harness/open-code/runtime-state'

const TEST_TOKEN = 'defer-test-kortix-token-32-chars'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-defer-'))
const ROOT = 'ses_live_turn'
let testEnvFileSequence = 0

const ORIGINAL_FETCH = globalThis.fetch
/** Flips whether the pinned root reads as mid-turn to `opencodeTurnInFlight`. */
let turnInFlight = true

function stubOpencodeFetch() {
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input)
    if (url.includes('/session/status')) {
      return new Response(
        JSON.stringify(turnInFlight ? { [ROOT]: { type: 'busy' } } : {}),
        { status: 200 },
      )
    }
    if (/\/message\?/.test(url)) {
      // A live, still-streaming assistant message when a turn is in flight;
      // an idle (empty) root otherwise.
      const body = turnInFlight
        ? [
            { info: { id: 'msg_prompt', role: 'user' } },
            { info: { id: 'msg_reply', role: 'assistant', parentID: 'msg_prompt', time: {} } },
          ]
        : []
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
}

let stateDir: string
// `applyOpencodeRuntimeEnv` (control.ts) writes process.env directly
// (KORTIX_SECRET_CAPABILITIES, KORTIX_OPENCODE_MODEL, ...). One `bun test`
// process runs every file in this package, so each row must restore exactly
// what it changed — otherwise a later row's identical push reads as
// "unchanged" against the PRIOR row's leftover value and never asks
// mayPromote at all. Same snapshot/restore shape as
// env-route-secret-respawn.test.ts.
let envSnapshot: NodeJS.ProcessEnv
beforeEach(() => {
  envSnapshot = { ...process.env }
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-env-defer-state-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
  writeOpenCodeSessionPin(ROOT)
  turnInFlight = true
  stubOpencodeFetch()
  resetConfigReleaseStateForTests()
  resetOpencodeEnvRestartPendingForTests()
})
afterEach(() => {
  ;(globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH
  resetConfigReleaseStateForTests()
  resetOpencodeEnvRestartPendingForTests()
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key]
  Object.assign(process.env, envSnapshot)
  rmSync(stateDir, { recursive: true, force: true })
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
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
  }
}

type ReloadCall = { mustRespawn: boolean; hadMayPromote: boolean }

/**
 * Simulates `lifecycle.ts`'s real contract: a `mustRespawn` reload asks
 * `mayPromote` right before it would promote, and DECLINES (`kept-old`) when
 * it resolves false — exactly what `reloadVerified` does. This is the seam
 * `applyEnvironment` and the real lifecycle share; faking it here proves the
 * control-service side of the contract without re-testing `reloadVerified`
 * itself (covered by `opencode-lifecycle.e2e.test.ts`).
 */
function fakeOpencode(): { opencode: Opencode; calls: ReloadCall[] } {
  const calls: ReloadCall[] = []
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:4096',
    restart: async () => {},
    reloadConfig: async (opts: { mustRespawn?: boolean; mayPromote?: () => Promise<boolean> } = {}) => {
      const hadMayPromote = typeof opts.mayPromote === 'function'
      calls.push({ mustRespawn: Boolean(opts.mustRespawn), hadMayPromote })
      if (opts.mustRespawn) {
        const mayPromote = (await opts.mayPromote?.()) ?? true
        if (!mayPromote) {
          return { how: 'kept-old', turnEnded: false } satisfies ReloadConfigResult
        }
      }
      return { how: 'restarted', turnEnded: false } satisfies ReloadConfigResult
    },
  } as unknown as Opencode
  return { opencode, calls }
}

function buildTestApp(opencode: Opencode, store: ReturnType<typeof createProjectEnvStore>) {
  const cfg = baseConfig()
  const control = createOpenCodeControlService(opencode, createOpenCodeQuickQueueInterrupt(opencode, cfg)).bind({
    cfg,
    projectEnv: store,
    agentEnvFile: join(TEST_ENV_DIR, `agent-env-${testEnvFileSequence++}.sh`),
  })
  return { app: new Hono().route('/kortix/env', createEnvRouter(cfg, control)), cfg }
}

async function postEnv(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('/kortix/env', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const SECRET_CAPS_PUSH = {
  revision: 'rev-1',
  env: {},
  names: [],
  opencodeEnv: {
    KORTIX_SECRET_CAPABILITIES: '{"version":1,"capabilities":[{"identifier":"WEATHER_API","delivery":"https_broker"}]}',
  },
  refreshModels: true,
}

describe('env route — a config-affecting restart never kills an accepted turn', () => {
  test('always supplies mayPromote on a mustRespawn reload', async () => {
    const { opencode, calls } = fakeOpencode()
    const { app } = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))
    turnInFlight = false

    const { status } = await postEnv(app, SECRET_CAPS_PUSH)

    expect(status).toBe(200)
    expect(calls).toEqual([{ mustRespawn: true, hadMayPromote: true }])
  })

  test('a turn in flight declines the promotion; the box reports kept-old, not a kill', async () => {
    const { opencode, calls } = fakeOpencode()
    const { app } = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))
    turnInFlight = true // the pinned root is mid-turn per the fetch stub above

    const { status, json } = await postEnv(app, SECRET_CAPS_PUSH)

    expect(status).toBe(200)
    expect(json.opencode_reload).toBe('kept-old')
    expect(calls).toEqual([{ mustRespawn: true, hadMayPromote: true }])
    expect(opencodeEnvRestartIsPendingForTests()).toBe(true)
  })

  test('an unreadable turn state ALSO declines — cannot-tell counts as busy, never as permission', async () => {
    const { opencode, calls } = fakeOpencode()
    const { app } = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))
    ;(globalThis as { fetch: unknown }).fetch = async () => new Response('boom', { status: 503 })

    const { json } = await postEnv(app, SECRET_CAPS_PUSH)

    expect(json.opencode_reload).toBe('kept-old')
    expect(calls).toEqual([{ mustRespawn: true, hadMayPromote: true }])
  })

  test('the deferred restart is retried once the box proves it is idle', async () => {
    const { opencode, calls } = fakeOpencode()
    const { app, cfg } = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))
    turnInFlight = true

    const deferred = await postEnv(app, SECRET_CAPS_PUSH)
    expect(deferred.json.opencode_reload).toBe('kept-old')
    expect(calls).toHaveLength(1)
    expect(opencodeEnvRestartIsPendingForTests()).toBe(true)

    // The turn finishes; the box's own session.idle frame retries.
    turnInFlight = false
    await retryDeferredOpencodeEnvRestart(opencode, cfg.workspace)

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ mustRespawn: true, hadMayPromote: true })
    expect(opencodeEnvRestartIsPendingForTests()).toBe(false)
  })

  test('retrying while still busy leaves the restart pending for the next idle boundary', async () => {
    const { opencode, calls } = fakeOpencode()
    const { app, cfg } = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))
    turnInFlight = true

    await postEnv(app, SECRET_CAPS_PUSH)
    await retryDeferredOpencodeEnvRestart(opencode, cfg.workspace) // still busy

    expect(calls).toHaveLength(2)
    expect(opencodeEnvRestartIsPendingForTests()).toBe(true)
  })

  test('a plain dispose-path push (no respawn needed) never asks mayPromote', async () => {
    const { opencode, calls } = fakeOpencode()
    const { app } = buildTestApp(
      opencode,
      createProjectEnvStore({ KORTIX_PROJECT_SECRETS_REVISION: 'rev-1', KORTIX_PROJECT_SECRET_NAMES: '' } as NodeJS.ProcessEnv),
    )
    turnInFlight = true // irrelevant: the dispose path never retires a process

    const { status, json } = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_OPENCODE_MODEL: 'kortix/claude-sonnet-4' },
    })

    expect(status).toBe(200)
    expect(json.opencode_reload).toBe('restarted')
    expect(calls).toEqual([{ mustRespawn: false, hadMayPromote: false }])
  })
})
