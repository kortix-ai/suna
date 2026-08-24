/**
 * A boundary secret added to a LIVE session has to arm the shim.
 *
 * `startEgressShim` runs at cold boot and at fork adoption, and nowhere else.
 * The hot push through `/kortix/env` delivered the new capability catalog and
 * respawned opencode, but the respawn spread `egressShimEnv()` — still empty,
 * because nothing had started a listener. The secret saved, the catalog landed,
 * the box reported success, and every request still left uncredentialed until
 * someone restarted the session.
 *
 * The route therefore re-resolves the rules and arms/stops the listener BEFORE
 * `writeAgentEnvFile`, the same ordering boot and fork adoption use, because
 * that file is the channel the proxy + CA variables reach the agent's shells
 * through — and the channel that has to stop advertising them once the last
 * boundary secret is gone.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import { __resetEgressShimForTests, egressShimEnv, stopEgressShim } from '../egress-shim'
import type { Opencode } from '../opencode'
import { createProjectEnvStore } from '../project-env'
import { buildOpencodeApp } from '../proxy'

const TEST_TOKEN = 'egress-shim-test-kortix-token-32ch'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-shim-'))
/** Well clear of the daemon's own 4319/4320/4321 block. */
const PORT = 45322
const SESSION_ENV = {
  KORTIX_EGRESS_SHIM_PORT: String(PORT),
  KORTIX_API_URL: 'https://api.kortix.test/v1',
  KORTIX_PROJECT_ID: 'proj-hot-push',
  KORTIX_TOKEN: 'kortix_pat_hot_push',
} as const

let testEnvFileSequence = 0
let restoreEnv: Array<[string, string | undefined]> = []
let squatter: net.Server | null = null

beforeEach(() => {
  restoreEnv = Object.entries(SESSION_ENV).map(([name]) => [name, process.env[name]])
  restoreEnv.push(['KORTIX_SECRET_CAPABILITIES', process.env.KORTIX_SECRET_CAPABILITIES])
  for (const [name, value] of Object.entries(SESSION_ENV)) process.env[name] = value
  delete process.env.KORTIX_SECRET_CAPABILITIES
})

afterEach(async () => {
  stopEgressShim()
  __resetEgressShimForTests()
  if (squatter) {
    const server = squatter
    squatter = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const [name, value] of restoreEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

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
    projectId: 'proj-hot-push',
    apiUrl: 'https://api.kortix.test/v1',
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

/** Records the proxy env as opencode's respawn would have seen it. */
function fakeOpencode(): { opencode: Opencode; proxyAtReload: Array<string | undefined> } {
  const proxyAtReload: Array<string | undefined> = []
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
    reloadConfig: async () => {
      proxyAtReload.push(egressShimEnv().HTTPS_PROXY)
      return { how: 'restarted' as const, turnEnded: false }
    },
  } as unknown as Opencode
  return { opencode, proxyAtReload }
}

function catalog(rules: Array<{ identifier: string; hosts: string[] }>): string {
  return JSON.stringify({
    version: 1,
    capabilities: rules.map((rule) => ({ ...rule, delivery: 'network' })),
  })
}

function buildTestApp(opencode: Opencode): { app: ReturnType<typeof buildOpencodeApp>; envFile: string } {
  const envFile = join(TEST_ENV_DIR, `agent-env-${testEnvFileSequence++}.sh`)
  const store = createProjectEnvStore({
    KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
    KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
    API_KEY: 'v1',
  } as NodeJS.ProcessEnv)
  const app = buildOpencodeApp(
    baseConfig(),
    opencode,
    Date.now(),
    { repoMaterializationError: null, timeline: [] },
    store,
    null,
    undefined,
    envFile,
  )
  return { app, envFile }
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

describe('env route — mid-session boundary rules arm the shim', () => {
  it('the first boundary secret starts the listener and exports the proxy to the shells', async () => {
    const { opencode, proxyAtReload } = fakeOpencode()
    const { app, envFile } = buildTestApp(opencode)

    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      refreshModels: true,
      opencodeEnv: {
        KORTIX_SECRET_CAPABILITIES: catalog([
          { identifier: 'WEATHER_API', hosts: ['api.weather.test'] },
        ]),
      },
    })

    expect(status).toBe(200)
    expect(json.egress_shim).toBe('started')
    expect(json.egress_shim_hosts).toEqual(['api.weather.test'])
    // Written AFTER the arm, so the agent's shells get the proxy on this push
    // rather than on the next one.
    expect(readFileSync(envFile, 'utf8')).toContain(`export HTTPS_PROXY='http://127.0.0.1:${PORT}'`)
    // And the respawn triggered by the same push inherits it — a catalog change
    // is respawn-required, so this is the path opencode itself takes.
    expect(proxyAtReload).toEqual([`http://127.0.0.1:${PORT}`])
  })

  it('withdrawing the last boundary secret stops the listener and stops exporting the proxy', async () => {
    const { opencode } = fakeOpencode()
    const { app, envFile } = buildTestApp(opencode)

    await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      opencodeEnv: {
        KORTIX_SECRET_CAPABILITIES: catalog([
          { identifier: 'WEATHER_API', hosts: ['api.weather.test'] },
        ]),
      },
    })
    expect(readFileSync(envFile, 'utf8')).toContain('export HTTPS_PROXY=')

    const { status, json } = await postEnv(app, {
      revision: 'rev-3',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      opencodeEnv: { KORTIX_SECRET_CAPABILITIES: catalog([]) },
    })

    expect(status).toBe(200)
    expect(json.egress_shim).toBe('stopped')
    // An HTTPS_PROXY left pointing at a dead listener breaks every outbound
    // call the agent makes — strictly worse than never having armed one.
    expect(readFileSync(envFile, 'utf8')).not.toContain('HTTPS_PROXY')
  })

  it('a push that does not move the rules leaves the running listener alone', async () => {
    const { opencode } = fakeOpencode()
    const { app } = buildTestApp(opencode)
    const rules = [{ identifier: 'WEATHER_API', hosts: ['api.weather.test'] }]

    await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v1' },
      names: ['API_KEY'],
      opencodeEnv: { KORTIX_SECRET_CAPABILITIES: catalog(rules) },
    })
    const armed = egressShimEnv()

    // A plain secret-CRUD fan-out re-sends the whole catalog. Restarting on it
    // would drop the agent's in-flight tunnels for nothing.
    const { status, json } = await postEnv(app, {
      revision: 'rev-3',
      env: { API_KEY: 'v2' },
      names: ['API_KEY'],
      opencodeEnv: { KORTIX_SECRET_CAPABILITIES: catalog(rules) },
    })

    expect(status).toBe(200)
    expect(json.changed).toBe(true)
    expect(json.egress_shim).toBe('unchanged')
    expect(egressShimEnv()).toBe(armed)
  })

  it('a listener that cannot bind still lets the rest of the env push land', async () => {
    squatter = net.createServer()
    await new Promise<void>((resolve) => squatter!.listen(PORT, '127.0.0.1', () => resolve()))

    const { opencode } = fakeOpencode()
    const { app } = buildTestApp(opencode)

    const { status, json } = await postEnv(app, {
      revision: 'rev-2',
      env: { API_KEY: 'v2' },
      names: ['API_KEY'],
      opencodeEnv: {
        KORTIX_SECRET_CAPABILITIES: catalog([
          { identifier: 'WEATHER_API', hosts: ['api.weather.test'] },
        ]),
      },
    })

    expect(status).toBe(200)
    expect(json.egress_shim).toBe('failed')
    // The project secrets, model and gateway mode in the same body are
    // independent of the shim and must still apply.
    expect(json.changed).toBe(true)
    expect(json.agent_env_written).toBe(true)
  })
})
