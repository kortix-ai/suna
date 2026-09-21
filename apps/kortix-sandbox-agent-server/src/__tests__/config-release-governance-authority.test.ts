/**
 * While a config release is active, its compiled governance is authoritative.
 * A `/kortix/env` push carrying `KORTIX_COMPILED_AGENT_CONFIG` (an API that
 * predates config releases) must not replace it for the next spawn. Without an
 * active release the push behaves as it always did.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpenCodeQuickQueueInterrupt } from '../harness/open-code/background'
import { recordBootConfig, resetConfigReleaseStateForTests } from '../harness/open-code/config-release'
import { createOpenCodeControlService } from '../harness/open-code/control'
import type { Opencode } from '../harness/open-code/lifecycle'
import { createProjectEnvStore } from '../project-env'
import { createEnvRouter } from '../routes/env'

const TOKEN = 'governance-authority-token-32-chars'
const DIR = mkdtempSync(join(tmpdir(), 'kortix-governance-authority-'))
const RELEASE_GOV = '{"agent":{"kortix":{"prompt":"from the release"}}}'
const PUSHED_GOV = '{"agent":{"kortix":{"prompt":"from an env push"}}}'
let sequence = 0

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

function app() {
  const calls: Array<{ mustRespawn: boolean }> = []
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 1,
    getInternalUrl: () => 'http://127.0.0.1:1',
    reloadConfig: async (opts: { mustRespawn?: boolean } = {}) => {
      calls.push({ mustRespawn: Boolean(opts.mustRespawn) })
      return { how: 'restarted' as const, turnEnded: false }
    },
  } as unknown as Opencode
  const cfg = {
    sandboxToken: TOKEN,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
  } as unknown as Config
  const store = createProjectEnvStore({ KORTIX_PROJECT_SECRETS_REVISION: 'rev-1', KORTIX_PROJECT_SECRET_NAMES: '' } as NodeJS.ProcessEnv)
  const control = createOpenCodeControlService(opencode, createOpenCodeQuickQueueInterrupt(opencode, cfg)).bind({
    cfg,
    projectEnv: store,
    agentEnvFile: join(DIR, `agent-env-${sequence++}.sh`),
  })
  return { app: new Hono().route('/kortix/env', createEnvRouter(cfg, control)), calls }
}

async function pushGovernance(target: Hono) {
  const res = await target.request('/kortix/env', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: 'rev-1',
      env: {},
      names: [],
      opencodeEnv: { KORTIX_COMPILED_AGENT_CONFIG: PUSHED_GOV, KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'ffffffffffffffff' },
      refreshModels: true,
    }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  resetConfigReleaseStateForTests()
  process.env.KORTIX_COMPILED_AGENT_CONFIG = RELEASE_GOV
  process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG = '0123456789abcdef'
})

afterEach(() => {
  resetConfigReleaseStateForTests()
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG
  delete process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG
})

describe('compiled governance while a config release is active', () => {
  it('an env push does not replace the release governance and does not respawn for it', async () => {
    recordBootConfig({ source: 'release', release_id: 'a'.repeat(64), source_commit: 'b'.repeat(40), proven: true })
    const { app: target, calls } = app()
    const { status, json } = await pushGovernance(target)
    expect(status).toBe(200)
    expect(json.opencode_env_changed).toBe(false)
    expect(json.opencode_reload).toBeNull()
    expect(calls).toEqual([])
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(RELEASE_GOV)
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe('0123456789abcdef')
  })

  it('a governance-only release (image default) is authoritative too', async () => {
    recordBootConfig({ source: 'image-default', release_id: 'c'.repeat(64), proven: true })
    const { app: target } = app()
    await pushGovernance(target)
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(RELEASE_GOV)
  })

  it('without an active release the push applies and restarts, as before', async () => {
    recordBootConfig({ source: 'workspace' })
    const { app: target, calls } = app()
    const { status, json } = await pushGovernance(target)
    expect(status).toBe(200)
    expect(json.opencode_env_changed).toBe(true)
    expect(json.opencode_env_names).toEqual(['KORTIX_COMPILED_AGENT_CONFIG', 'KORTIX_COMPILED_AGENT_CONFIG_ETAG'])
    expect(calls).toHaveLength(1)
    expect(process.env.KORTIX_COMPILED_AGENT_CONFIG).toBe(PUSHED_GOV)
  })
})
