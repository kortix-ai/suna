import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'bun:test'

import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { createProjectEnvStore } from '../project-env'
import { buildOpencodeApp } from '../proxy'

const TEST_TOKEN = 'curl-test-kortix-token'
const execFileAsync = promisify(execFile)

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
    kortixToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
  }
}

function fakeOpencode(onRestart: () => void): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => onRestart(),
  } as unknown as Opencode
}

async function curlJson(url: string, body: string): Promise<{ status: number; body: string }> {
  const { stdout } = await execFileAsync('curl', [
    '-sS',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${TEST_TOKEN}`,
    '-H', 'Content-Type: application/json',
    '-d', body,
    '-w', '\n%{http_code}',
    url,
  ], { encoding: 'utf8', timeout: 5_000 })
  const idx = stdout.lastIndexOf('\n')
  return {
    body: stdout.slice(0, idx),
    status: Number(stdout.slice(idx + 1)),
  }
}

describe('project env sync curl e2e', () => {
  it('updates running daemon env state through curl without restarting the sandbox', async () => {
    let restarts = 0
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'old',
    } as NodeJS.ProcessEnv)
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode(() => { restarts += 1 }),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      store,
    )
    const server = Bun.serve({ port: 0, fetch: app.fetch })

    try {
      const first = await curlJson(`http://127.0.0.1:${server.port}/kortix/env`, JSON.stringify({
        revision: 'rev-curl-1',
        env: { API_KEY: 'new', EXTRA_TOKEN: 'fresh' },
        names: ['API_KEY', 'EXTRA_TOKEN'],
      }))
      expect(first.status).toBe(200)
      expect(JSON.parse(first.body)).toMatchObject({
        ok: true,
        changed: true,
        revision: 'rev-curl-1',
      })
      expect(store.snapshot()).toMatchObject({
        revision: 'rev-curl-1',
        env: { API_KEY: 'new', EXTRA_TOKEN: 'fresh' },
        names: ['API_KEY', 'EXTRA_TOKEN'],
      })
      expect(restarts).toBe(1)

      const replay = await curlJson(`http://127.0.0.1:${server.port}/kortix/env`, JSON.stringify({
        revision: 'rev-curl-1',
        env: { API_KEY: 'new', EXTRA_TOKEN: 'fresh' },
        names: ['API_KEY', 'EXTRA_TOKEN'],
      }))
      expect(replay.status).toBe(200)
      expect(JSON.parse(replay.body)).toMatchObject({ ok: true, changed: false })
      expect(restarts).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})
