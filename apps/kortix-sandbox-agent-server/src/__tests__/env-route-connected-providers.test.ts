/**
 * `/kortix/env` carries `KORTIX_LLM_CONNECTED_PROVIDERS` — the catalog provider
 * ids this project has connected. It is the one env name on the runtime
 * allowlist that is accepted and stored WITHOUT being config-affecting.
 *
 * WHY IT MUST NOT TRIP THE RELOAD GATE
 * OpenCode never reads that name. Its provider map comes from the CATALOG FILE.
 * Letting the name reach `reloadConfig` would restart the box on the OLD
 * catalog — before anything has fetched the models the newly connected provider
 * adds — so the restart would be pure cost and the box would still answer
 * `ModelNotFound` for the model the user just picked.
 *
 * What it does instead is schedule the model reconcile, which settles the live
 * catalogs, diffs them against the running provider map, and restarts ONLY when
 * a model the picker can now offer is genuinely absent.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { resetModelReconcileForTests } from '../model-reconcile'
import { createProjectEnvStore } from '../project-env'
import { buildOpencodeApp } from '../proxy'

const TEST_TOKEN = 'connected-providers-test-token-32ch'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-providers-'))
let sequence = 0

afterAll(() => rmSync(TEST_ENV_DIR, { recursive: true, force: true }))

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

function fakeOpencode(): { opencode: Opencode; reloads: { mustRespawn: boolean }[] } {
  const reloads: { mustRespawn: boolean }[] = []
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
    reloadConfig: async (opts: { mustRespawn?: boolean } = {}) => {
      reloads.push({ mustRespawn: Boolean(opts.mustRespawn) })
      return { how: 'restarted' as const, turnEnded: null }
    },
  } as unknown as Opencode
  return { opencode, reloads }
}

async function postEnv(
  app: ReturnType<typeof buildOpencodeApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('/kortix/env', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

function buildTestApp(opencode: Opencode) {
  const store = createProjectEnvStore({
    KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
    KORTIX_PROJECT_SECRET_NAMES: '',
  } as NodeJS.ProcessEnv)
  return buildOpencodeApp(
    baseConfig(),
    opencode,
    Date.now(),
    { repoMaterializationError: null, timeline: [] },
    store,
    null,
    undefined,
    join(TEST_ENV_DIR, `agent-env-${sequence++}.sh`),
  )
}

describe('env route — KORTIX_LLM_CONNECTED_PROVIDERS', () => {
  it('is applied to process.env and reported, but never reloads opencode by itself', async () => {
    // No reconcile handles registered ⇒ scheduleModelReconcile is a no-op, which
    // is exactly the isolation this case wants: it asserts the RELOAD decision.
    resetModelReconcileForTests()
    delete process.env.KORTIX_LLM_CONNECTED_PROVIDERS
    const { opencode, reloads } = fakeOpencode()
    const app = buildTestApp(opencode)

    const { status, json } = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_LLM_CONNECTED_PROVIDERS: 'anthropic,openrouter' },
    })

    expect(status).toBe(200)
    expect(String(process.env.KORTIX_LLM_CONNECTED_PROVIDERS)).toBe('anthropic,openrouter')
    // Reported, so the API can see the push landed...
    expect(json.opencode_env_names).toEqual(['KORTIX_LLM_CONNECTED_PROVIDERS'])
    // ...but NOT counted as a config change, and no reload was performed.
    expect(json.opencode_env_changed).toBe(false)
    expect(reloads).toEqual([])
    expect(json.opencode_reload).toBeNull()
  })

  it('does not suppress a reload that a genuinely config-affecting name earns', async () => {
    resetModelReconcileForTests()
    delete process.env.KORTIX_LLM_CONNECTED_PROVIDERS
    delete process.env.KORTIX_OPENCODE_MODEL
    const { opencode, reloads } = fakeOpencode()
    const app = buildTestApp(opencode)

    const { status, json } = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: {
        KORTIX_LLM_CONNECTED_PROVIDERS: 'anthropic',
        KORTIX_OPENCODE_MODEL: 'kortix/grok-4.6',
      },
    })

    expect(status).toBe(200)
    expect(json.opencode_env_changed).toBe(true)
    expect(reloads).toHaveLength(1)
    // The model change alone decides the respawn; the provider list is not on
    // RESPAWN_REQUIRED_ENV_NAMES and must not force one.
    expect(reloads[0]!.mustRespawn).toBe(false)
  })

  it('an unchanged provider list is not a change at all', async () => {
    resetModelReconcileForTests()
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    const { opencode, reloads } = fakeOpencode()
    const app = buildTestApp(opencode)

    const { status, json } = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_LLM_CONNECTED_PROVIDERS: 'anthropic' },
    })

    expect(status).toBe(200)
    expect(json.opencode_env_names).toEqual([])
    expect(reloads).toEqual([])
    delete process.env.KORTIX_LLM_CONNECTED_PROVIDERS
  })
})
