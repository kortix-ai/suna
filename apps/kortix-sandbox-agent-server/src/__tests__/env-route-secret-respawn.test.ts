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
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import type { Opencode } from '../harness/open-code/lifecycle'
import { createProjectEnvStore } from '../project-env'
import { Hono } from 'hono'
import { createEnvRouter } from '../routes/env'
import { createOpenCodeControlService } from '../harness/open-code/control'
import { resetConfigReleaseStateForTests } from '../harness/open-code/config-release'
import { createOpenCodeQuickQueueInterrupt } from '../harness/open-code/background'
import { resetConfigReleaseStateForTests } from '../harness/open-code/config-release'
import {
  __resetRuntimeProjectionRelayForTests,
  __setRuntimeProjectionStateReaderForTests,
} from '../harness/open-code/runtime-projection-relay'

const TEST_TOKEN = 'respawn-test-kortix-token-32-chars'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-respawn-'))
let testEnvFileSequence = 0

afterAll(() => rmSync(TEST_ENV_DIR, { recursive: true, force: true }))

// The route writes process.env (runtime env names, revoked secrets). One
// `bun test` process runs every file, so each row restores what it changed.
let envSnapshot: NodeJS.ProcessEnv
beforeEach(() => {
  resetConfigReleaseStateForTests()
  envSnapshot = { ...process.env }
  delete process.env.KORTIX_CONNECTORS_MCP_ENABLED
  resetConfigReleaseStateForTests()
})
afterEach(() => {
  resetConfigReleaseStateForTests()
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key]
  Object.assign(process.env, envSnapshot)
  resetConfigReleaseStateForTests()
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
      return { how: 'restarted' as const, turnEnded: false }
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
  return new Hono().route('/kortix/env', createEnvRouter(cfg, control))
}

async function postEnv(
  app: Hono,
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
  it('a secret capability catalog change forces a respawn', async () => {
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: '',
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    const { status } = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      opencodeEnv: {
        KORTIX_SECRET_CAPABILITIES:
          '{"version":1,"capabilities":[{"identifier":"WEATHER_API","delivery":"https_broker"}]}',
      },
      refreshModels: true,
    })

    expect(status).toBe(200)
    expect(calls).toEqual([{ mustRespawn: true }])
  })

  // Any value delta in the project secrets: the opencode child's PROCESS env
  // (set at spawn by mergeProjectEnv) is stale, and a dispose would report
  // success while the PID kept the old set.
  it.each([
    ['CHANGE (value moved)', { API_KEY: 'v1' }, { API_KEY: 'v2' }],
    ['ADD (new secret granted)', { API_KEY: 'v1' }, { API_KEY: 'v1', STRIPE_KEY: 'sk_live_new' }],
    ['REVOCATION (secret dropped)', { API_KEY: 'v1', STRIPE_KEY: 'sk_live_old' }, { API_KEY: 'v1' }],
  ])('a project-secret %s forces a respawn', async (_name, boot, next) => {
    const { opencode, calls } = fakeOpencode()
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
      KORTIX_PROJECT_SECRET_NAMES: Object.keys(boot).join(','),
      ...boot,
    } as NodeJS.ProcessEnv)
    const app = buildTestApp(opencode, store)

    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: next,
      names: Object.keys(next),
      refreshModels: true,
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(true)
    expect(calls).toEqual([{ mustRespawn: true }])
  })

  it('removes a revoked project secret from the daemon environment', async () => {
    const name = 'LIVE_REVOKE_TEST_KEY'
    const previous = process.env[name]
    process.env[name] = 'boot-value'

    try {
      const { opencode } = fakeOpencode()
      const store = createProjectEnvStore({
        KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
        KORTIX_PROJECT_SECRET_NAMES: name,
        [name]: 'boot-value',
      } as NodeJS.ProcessEnv)
      const app = buildTestApp(opencode, store)

      const { status } = await postEnv(app, {
        revision: 'rev-2',
        env: {},
        names: [],
        refreshModels: true,
      })

      expect(status).toBe(200)
      expect(process.env[name]).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
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

  it('enabling the connectors MCP face mid-session takes the dispose path', async () => {
    // Pins CURRENT behaviour, which is not obviously the intended one.
    // `KORTIX_CONNECTORS_MCP_ENABLED` shapes `out.mcp` inside the config file,
    // so it follows the config-file rule and disposes rather than respawns —
    // consistent with RESPAWN_REQUIRED_ENV_NAMES (lifecycle.ts).
    //
    // But routes/env.ts:21 claims this variable "must restart OpenCode because
    // MCP servers are registered only at spawn". If that claim is right, the
    // email channel's mid-session enable (channels/email/session.ts:123, 208)
    // silently does nothing and this expectation should flip to `true`. Nobody
    // has measured which is true against the pinned opencode — see the note on
    // RESPAWN_REQUIRED_ENV_NAMES in opencode.ts.
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
      opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
    })

    expect(status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mustRespawn).toBe(false)
  })

  it('a connectors-MCP push reloads once and sets the env; re-pushing the SAME value reloads nothing', async () => {
    // The fleet default sets this at boot, so every caller that includes it
    // re-sends it. The route compares against process.env before marking the
    // name changed: an identical value produces no reload at all.
    const { opencode, calls } = fakeOpencode()
    const app = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))
    const push = () =>
      postEnv(app, {
        revision: 'rev-email-mcp',
        env: {},
        names: [],
        refreshModels: true,
        opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
      })

    const first = await push()
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ opencode_env_changed: true, opencode_env_names: ['KORTIX_CONNECTORS_MCP_ENABLED'] })
    expect(process.env.KORTIX_CONNECTORS_MCP_ENABLED as string | undefined).toBe('1')
    expect(calls).toHaveLength(1)

    const replay = await push()
    expect(replay.status).toBe(200)
    expect(replay.json).toMatchObject({ opencode_env_changed: false, opencode_env_names: [] })
    expect(calls).toHaveLength(1)
  })

  it('a runtime env value sets process.env and reloads; null deletes it and reloads again', async () => {
    const { opencode, calls } = fakeOpencode()
    delete process.env.KORTIX_LLM_BASE_URL
    const app = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))

    const on = await postEnv(app, {
      revision: 'rev-gateway-on',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm' },
    })
    expect(on.json).toMatchObject({ opencode_env_changed: true, opencode_env_names: ['KORTIX_LLM_BASE_URL'] })
    expect(process.env.KORTIX_LLM_BASE_URL as string | undefined).toBe('https://api.kortix.test/v1/llm')

    const off = await postEnv(app, {
      revision: 'rev-gateway-off',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_LLM_BASE_URL: null },
    })
    expect(off.json).toMatchObject({ opencode_env_changed: true, opencode_env_names: ['KORTIX_LLM_BASE_URL'] })
    expect(process.env.KORTIX_LLM_BASE_URL).toBeUndefined()
    expect(calls).toEqual([{ mustRespawn: false }, { mustRespawn: false }])
  })

  it('the compiled agent config is live-updatable; an unknown KORTIX_* name is ignored', async () => {
    // Every runtime env name must be on the route's allowlist, or the API can
    // never change it on a running box. An unlisted name must not reach the
    // environment at all.
    const { opencode, calls } = fakeOpencode()
    delete process.env.KORTIX_COMPILED_AGENT_CONFIG
    delete process.env.KORTIX_FOO
    // The project secrets do not move (same revision), so only the runtime env
    // name can trigger a reload.
    const app = buildTestApp(
      opencode,
      createProjectEnvStore({ KORTIX_PROJECT_SECRETS_REVISION: 'rev-1' } as NodeJS.ProcessEnv),
    )

    const unknown = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_FOO: 'x' },
    })
    expect(unknown.json).toMatchObject({ opencode_env_changed: false, opencode_env_names: [] })
    expect(process.env.KORTIX_FOO).toBeUndefined()
    expect(calls).toHaveLength(0)

    const compiled = JSON.stringify({ agent: { support: { mode: 'primary' } } })
    const applied = await postEnv(app, {
      revision: 'rev-1',
      env: {},
      names: [],
      refreshModels: true,
      opencodeEnv: { KORTIX_COMPILED_AGENT_CONFIG: compiled },
    })
    expect(applied.json).toMatchObject({ opencode_env_changed: true, opencode_env_names: ['KORTIX_COMPILED_AGENT_CONFIG'] })
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG as string | undefined).toBe(compiled)
    expect(calls).toHaveLength(1)
  })

  it('a byte-identical push (no change at all) does not reload opencode', async () => {
    // The boot-revision-matches guard: nothing moved, nothing to reload, even
    // with refreshModels set.
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

  it('an applied env push re-pushes the runtime projection to the control plane', async () => {
    // The daemon owns this write, so it tells the server-side projection
    // instead of waiting for an SSE frame to hint at the change.
    const posts: string[] = []
    const api = Bun.serve({
      port: 0,
      fetch(req) {
        posts.push(new URL(req.url).pathname)
        return Response.json({ ok: true })
      },
    })
    try {
      __resetRuntimeProjectionRelayForTests()
      __setRuntimeProjectionStateReaderForTests(async () => ({ doc: { built_at: 'now' } as never, etag: 'etag-env' }))
      process.env.KORTIX_SESSION_ID = 'sess-1'
      process.env.KORTIX_TOKEN = 'sandbox-token'
      process.env.KORTIX_API_URL = `http://127.0.0.1:${api.port}/v1`
      process.env.KORTIX_PROJECTION_RELAY_DEBOUNCE_MS = '5'
      const { opencode } = fakeOpencode()
      const app = buildTestApp(opencode, createProjectEnvStore({} as NodeJS.ProcessEnv))

      const { status } = await postEnv(app, {
        revision: 'rev-2',
        env: {},
        names: [],
        refreshModels: true,
        opencodeEnv: { KORTIX_OPENCODE_MODEL: 'kortix/claude-sonnet-4' },
      })
      expect(status).toBe(200)

      const deadline = Date.now() + 2_000
      while (posts.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(posts).toEqual(['/v1/platform/runtime-projection'])
    } finally {
      __resetRuntimeProjectionRelayForTests()
      api.stop(true)
    }
  })
})
