/**
 * Regression for the active-session env-refresh defect: a project-secret
 * delta delivered to the daemon's `/kortix/env` must force a full opencode
 * RESPAWN, not the ~51ms dispose fast path.
 *
 * Why this is load-bearing: the opencode child's PROCESS env is shaped at
 * SPAWN via `mergeProjectEnv` (opencode.ts) — project secrets are NOT in the
 * opencode config file. A dispose re-reads the config file only and never
 * re-runs `mergeProjectEnv` for the child's process env, so after a pure
 * secret-scope change opencode's PID keeps its stale (e.g. 0/47) snapshot
 * while `agent-env.sh` gets the new one (freshly-started shells see 47/47).
 * The box then reports a stale OpenCode until something else forces a respawn.
 *
 * The route's `mustRespawn` is therefore `projectSecretsMoved ||
 * requiresRespawn(opencodeEnvNames)`. The dispose fast path is preserved for
 * pure model/auth/deny changes that touch no project secret.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { createProjectEnvStore } from '../project-env'
import { buildOpencodeApp } from '../proxy'

const TEST_TOKEN = 'respawn-test-kortix-token-32-chars'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-respawn-'))
let testEnvFileSequence = 0

afterAll(() => rmSync(TEST_ENV_DIR, { recursive: true, force: true }))

function baseConfig(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
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
      return 'restarted' as const
    },
  } as unknown as Opencode
  return { opencode, calls }
}

function buildTestApp(opencode: Opencode, store: ReturnType<typeof createProjectEnvStore>) {
  return buildOpencodeApp(
    baseConfig(),
    opencode,
    Date.now(),
    { repoMaterializationError: null, timeline: [] },
    store,
    null,
    undefined,
    join(TEST_ENV_DIR, `agent-env-${testEnvFileSequence++}.sh`),
  )
}

async function postEnv(
  app: ReturnType<typeof buildOpencodeApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('/kortix/env', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('env route — project-secret delta forces respawn, not dispose', () => {
  it('a project-secret CHANGE (value moved) forces a respawn', async () => {
    const { opencode, calls } = fakeOpencode()
    // Boot store already has API_KEY=v1.
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'v1',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    // Push a new revision where API_KEY's value moved. refreshModels=true asks
    // for the reload; the project-secret delta is what demands a RESPAWN.
    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v2' },
      names: ['API_KEY'],
      refreshModels: true,
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(true)
    // Exactly one reload, and it MUST have been a respawn (mustRespawn=true).
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mustRespawn).toBe(true)
  })

  it('a project-secret ADD (new secret granted) forces a respawn', async () => {
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'v1',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    // The allowlist widens: a brand-new secret STRIPE_KEY is granted. The
    // opencode process env did not have it before, so a respawn is required to
    // run mergeProjectEnv and add it.
    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v1', STRIPE_KEY: 'sk_live_new' },
      names: ['API_KEY', 'STRIPE_KEY'],
      refreshModels: true,
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mustRespawn).toBe(true)
  })

  it('a project-secret REVOCATION (secret dropped) forces a respawn', async () => {
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY,STRIPE_KEY',
      API_KEY: 'v1',
      STRIPE_KEY: 'sk_live_old',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    // STRIPE_KEY is revoked: it leaves the env. The opencode process env still
    // holds it from spawn, so a respawn is required to clear it via
    // mergeProjectEnv's knownNames delete pass.
    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      refreshModels: true,
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mustRespawn).toBe(true)
  })

  it('a pure MODEL change (no project-secret delta) keeps the dispose fast path', async () => {
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'v1',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    // Only the model moves; project secrets are byte-identical. This is the
    // case the dispose fast path is FOR — mustRespawn must stay false so
    // reloadConfig can take the ~51ms dispose path.
    const { status, json } = await postEnv(app, {
      revision: 'rev-1',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      refreshModels: true,
      opencodeEnv: { KORTIX_OPENCODE_MODEL: 'kortix/claude-sonnet-4' },
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mustRespawn).toBe(false)
  })

  it('a gateway deny-list change forces a respawn even with no project-secret delta', async () => {
    // KORTIX_OPENCODE_DENY_ENV is a RESPAWN_REQUIRED name: a dispose cannot
    // re-run withoutDeniedProviderEnv, so the strip would be stale. This
    // predates and is independent of the project-secret fix; it must still
    // hold now that project secrets are OR'd into the same gate.
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'v1',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    const { status } = await postEnv(app, {
      revision: 'rev-1',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      refreshModels: true,
      opencodeEnv: { KORTIX_OPENCODE_DENY_ENV: 'ANTHROPIC_API_KEY,OPENAI_API_KEY' },
    })

    expect(status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mustRespawn).toBe(true)
  })

  it('a byte-identical push (no change at all) does not reload opencode', async () => {
    // The boot-revision-matches guard is unchanged: nothing moved, nothing to
    // reload. This is the contract the proxy-auth "matches the boot revision"
    // test also asserts.
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-boot',
      KORTIX_PROJECT_SECRET_NAMES: 'BOOT_SECRET',
      BOOT_SECRET: 'already-loaded',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    const { status, json } = await postEnv(app, {
      revision: 'rev-boot',
      env: { BOOT_SECRET: 'already-loaded' },
      names: ['BOOT_SECRET'],
      refreshModels: true,
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('a project-secret change WITHOUT refreshModels does not reload opencode', async () => {
    // refreshModels is the gate for the whole reloadConfig block. A plain
    // secret-CRUD fan-out propagates with refreshModels=false (only the
    // per-prompt and scope/model paths send true), so the env file is
    // rewritten but opencode is not disturbed. Tool shells still pick the
    // new value up via BASH_ENV on the next bash -c.
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'v1',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v2' },
      names: ['API_KEY'],
      // refreshModels omitted -> false
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
