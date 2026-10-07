/**
 * ROOT CAUSE, confirmed 2026-09-29: `applyOpencodeRuntimeEnv` (control.ts)
 * compares a pushed value against THIS PROCESS's `process.env`. Several of
 * the config-affecting names it tracks — `KORTIX_SECRET_CAPABILITIES`
 * foremost — are delivered ONLY by a live `/kortix/env` push, never baked
 * into the box's boot env. `process.env` is process-local: the instant the
 * daemon process restarts (an agent swap, a redeploy — exactly what a
 * release does on every long-lived box), that in-memory baseline is gone.
 * The FIRST push after the restart then reads an UNCHANGED value as
 * "changed" purely because the fresh process's baseline is `undefined`, and
 * forces an avoidable OpenCode respawn under whatever turn happens to be
 * starting (2026-09-29 incident, v0.13.42: this fired on every keyed trigger
 * session within 30 minutes of the release's own agent-swap restart).
 *
 * Fix: persist the applied names to disk (`runtime-state.ts`) on every
 * change, and restore them into `process.env` — only where boot did not
 * already set something — as the FIRST thing `runOpenCode` does, before
 * anything spawns. A fresh daemon process then starts with the same
 * baseline the prior one had, so a byte-identical push reads as unchanged.
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
  restoreOpencodeRuntimeEnvSnapshotIfUnset,
} from '@/harness/open-code/control'
import { resetConfigReleaseStateForTests } from '@/harness/open-code/config-release'
import { createOpenCodeQuickQueueInterrupt } from '@/harness/open-code/background'

const TEST_TOKEN = 'restart-amnesia-test-kortix-token'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-amnesia-'))
let testEnvFileSequence = 0

let stateDir: string
let priorStateDir: string | undefined
let envSnapshot: NodeJS.ProcessEnv
beforeEach(() => {
  priorStateDir = process.env.KORTIX_RUNTIME_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-env-amnesia-state-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
  resetConfigReleaseStateForTests()
  envSnapshot = { ...process.env }
  delete process.env.KORTIX_SECRET_CAPABILITIES
})
afterEach(() => {
  resetConfigReleaseStateForTests()
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key]
  Object.assign(process.env, envSnapshot)
  if (priorStateDir === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR
  else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDir
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

type ReloadCall = { mustRespawn: boolean }

function fakeOpencode(): { opencode: Opencode; calls: ReloadCall[] } {
  const calls: ReloadCall[] = []
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
    reloadConfig: async (opts: { mustRespawn?: boolean } = {}) => {
      calls.push({ mustRespawn: Boolean(opts.mustRespawn) })
      return { how: 'restarted', turnEnded: false } satisfies ReloadConfigResult
    },
  } as unknown as Opencode
  return { opencode, calls }
}

function buildTestApp(opencode: Opencode) {
  const cfg = baseConfig()
  // Every push in this suite carries `revision: 'rev-1'` and empty project
  // secrets. Pre-seeding the store at that SAME revision isolates the
  // assertions to the opencodeEnv slice this fix targets — a project-secrets
  // delta is a separate, already-durable mechanism (apps/api's
  // env-sync-durable-state.ts) and is not what this suite is proving.
  const projectEnv = createProjectEnvStore({
    KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
    KORTIX_PROJECT_SECRET_NAMES: '',
  } as NodeJS.ProcessEnv)
  const control = createOpenCodeControlService(opencode, createOpenCodeQuickQueueInterrupt(opencode, cfg)).bind({
    cfg,
    projectEnv,
    agentEnvFile: join(TEST_ENV_DIR, `agent-env-${testEnvFileSequence++}.sh`),
  })
  return new Hono().route('/kortix/env', createEnvRouter(cfg, control))
}

async function pushSecretCapabilities(app: Hono, catalog: string) {
  const res = await app.request('/kortix/env', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: 'rev-1',
      env: {},
      names: [],
      opencodeEnv: { KORTIX_SECRET_CAPABILITIES: catalog },
      refreshModels: true,
    }),
  })
  return (await res.json()) as Record<string, unknown>
}

const CATALOG = '{"version":1,"capabilities":[{"identifier":"WEATHER_API","delivery":"https_broker"}]}'

describe('opencode runtime env survives a daemon restart (no false change)', () => {
  test('a byte-identical push after a SIMULATED daemon restart does not respawn opencode', async () => {
    const first = fakeOpencode()
    const app1 = buildTestApp(first.opencode)

    const pushed = await pushSecretCapabilities(app1, CATALOG)
    expect(pushed.opencode_env_changed).toBe(true)
    expect(first.calls).toHaveLength(1)

    // SIMULATE A DAEMON RESTART: a fresh process's process.env has none of
    // the in-memory state the prior process set — `process.env` mutations
    // never survive a process exit. Nothing else in this repo can simulate
    // that without literally forking a new process; deleting the key and
    // restoring from the persisted snapshot IS the exact recovery a fresh
    // process performs at boot (`runOpenCode`'s first line).
    delete process.env.KORTIX_SECRET_CAPABILITIES
    restoreOpencodeRuntimeEnvSnapshotIfUnset()
    expect(process.env.KORTIX_SECRET_CAPABILITIES as string | undefined).toBe(CATALOG)

    // The "new" daemon process's own control service, over the same
    // restored process.env.
    const second = fakeOpencode()
    const app2 = buildTestApp(second.opencode)

    const replay = await pushSecretCapabilities(app2, CATALOG) // byte-identical
    expect(replay.opencode_env_changed).toBe(false)
    expect(second.calls).toHaveLength(0) // no respawn — nothing changed
  })

  test('WITHOUT the restore, the amnesia reproduces: an unchanged push respawns anyway', async () => {
    // This is the incident, reproduced. It stays in the suite as the negative
    // control: if a future change makes this pass, the fix regressed.
    const first = fakeOpencode()
    const app1 = buildTestApp(first.opencode)
    await pushSecretCapabilities(app1, CATALOG)

    delete process.env.KORTIX_SECRET_CAPABILITIES // the restart, WITHOUT the restore

    const second = fakeOpencode()
    const app2 = buildTestApp(second.opencode)
    const replay = await pushSecretCapabilities(app2, CATALOG)

    expect(replay.opencode_env_changed).toBe(true) // the false positive
    expect(second.calls).toHaveLength(1) // the avoidable respawn
  })

  test('the restore never overrides a value THIS boot already established', async () => {
    process.env.KORTIX_SECRET_CAPABILITIES = 'boot-established-value'
    // A stale snapshot from a much older push must not clobber it.
    const first = fakeOpencode()
    const app1 = buildTestApp(first.opencode)
    delete process.env.KORTIX_SECRET_CAPABILITIES
    await pushSecretCapabilities(app1, 'stale-catalog')
    process.env.KORTIX_SECRET_CAPABILITIES = 'boot-established-value' // boot set this fresh value

    restoreOpencodeRuntimeEnvSnapshotIfUnset()

    expect(process.env.KORTIX_SECRET_CAPABILITIES).toBe('boot-established-value')
  })

  test('a release-owned name is never restored — the config-release path owns it', async () => {
    const first = fakeOpencode()
    const app1 = buildTestApp(first.opencode)
    delete process.env.KORTIX_COMPILED_AGENT_CONFIG
    await app1.request('/kortix/env', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 'rev-1',
        env: {},
        names: [],
        opencodeEnv: { KORTIX_COMPILED_AGENT_CONFIG: '{"agent":{}}' },
        refreshModels: true,
      }),
    })

    delete process.env.KORTIX_COMPILED_AGENT_CONFIG
    restoreOpencodeRuntimeEnvSnapshotIfUnset()

    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined()
  })

  test('restoring twice is idempotent and harmless with nothing persisted', () => {
    expect(() => restoreOpencodeRuntimeEnvSnapshotIfUnset()).not.toThrow()
    expect(() => restoreOpencodeRuntimeEnvSnapshotIfUnset()).not.toThrow()
  })
})
