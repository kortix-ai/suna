import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { startProxy } from '../proxy'
import { createEnvRpcRouter } from '../routes/env-rpc'
// The worker half, imported from its real sources. `ws` loads lazily, so the
// HTTP-only test does not create a socket as an import side effect.
import { KortixExecutionEnv } from '../../../kortix-worker/src/kortix-env.ts'
import { LazyKortixEnv, mintUserContext } from '../../../kortix-worker/src/lazy-env.ts'
import { startWorker } from '../../../kortix-worker/src/worker.ts'

const WORKER_TOKEN = 'worker-session-token'
const ENVIRONMENT_TOKEN = 'environment-session-token'
const RPC_SECRET = 'purpose-bound-environment-rpc-secret'

interface Rig {
  stop(): Promise<void>
  ensureCalls: number
  workspace: string
  env: LazyKortixEnv
}

function proxyConfig(workspace: string): Config {
  return {
    servicePort: 0,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace,
    projectTarget: workspace,
    defaultBranch: 'main',
    branchFetchAttempts: 1,
    branchFetchDelaySec: 0.01,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    compiledBootMode: 'off',
    sandboxToken: ENVIRONMENT_TOKEN,
    envRpcSecret: RPC_SECRET,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
  }
}

function fakeOpencode(): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => null,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
  } as unknown as Opencode
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('condition did not become true before timeout')
}

/**
 * The whole P1.7 wire, end to end and real on both halves:
 *
 *   worker LazyKortixEnv ──ensure──▶ fake Kortix API (counts calls)
 *                        ──ops────▶ REAL daemon env-rpc router (real fs, real bash)
 *
 * The daemon router verifies the X-Kortix-User-Context signature, so a green
 * op also proves the worker's own header minting against the daemon's codec.
 */
async function buildRig(): Promise<Rig> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-env-ws-'))

  const daemon = new Hono()
  daemon.get('/kortix/health', (c) => c.json({ ok: true, repo_ready: true }))
  daemon.route(
    '/kortix/env-rpc',
    createEnvRpcRouter({
      sandboxToken: ENVIRONMENT_TOKEN,
      envRpcSecret: RPC_SECRET,
      workspace,
    } as unknown as Config),
  )
  const daemonServer = Bun.serve({ port: 0, fetch: daemon.fetch })

  const rig = { ensureCalls: 0 } as Rig
  const api = new Hono()
  api.post('/v1/projects/:pid/sessions/:sid/environment/ensure', (c) => {
    rig.ensureCalls += 1
    if (c.req.header('authorization') !== `Bearer ${WORKER_TOKEN}`) {
      return c.json({ error: 'bad token' }, 401)
    }
    return c.json({
      session_id: c.req.param('sid'),
      status: 'active',
      external_id: 'env-box-1',
      preview_url: `http://127.0.0.1:${daemonServer.port}`,
      preview_token: 'edge-token',
      rpc_secret: RPC_SECRET,
    })
  })
  const apiServer = Bun.serve({ port: 0, fetch: api.fetch })

  rig.workspace = workspace
  rig.env = new LazyKortixEnv({
    apiUrl: `http://127.0.0.1:${apiServer.port}/v1`,
    token: WORKER_TOKEN,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    cwd: workspace,
    ensureTimeoutMs: 10_000,
  })
  rig.stop = async () => {
    await rig.env.cleanup()
    daemonServer.stop(true)
    apiServer.stop(true)
    await fs.rm(workspace, { recursive: true, force: true })
  }
  return rig
}

let rig: Rig | null = null
afterEach(async () => {
  await rig?.stop()
  rig = null
})

describe('worker lazy environment ↔ daemon env-rpc', () => {
  test('one real websocket carries multiple remote file operations and closes on cleanup', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-env-ws-'))
    const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now())
    const env = new KortixExecutionEnv({
      baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
      cwd: workspace,
      headers: {
        'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-box-ws'),
      },
      transport: 'ws',
      timeoutMs: 5_000,
    })
    const transport = (
      env as unknown as {
        transport: { kind: string; ws?: { readyState: number } }
      }
    ).transport

    try {
      expect(transport.kind).toBe('ws')
      expect(transport.ws).toBeUndefined()

      expect(await env.writeFile('remote/answer.txt', '42\n')).toEqual({
        ok: true,
        value: undefined,
      })
      const socket = transport.ws
      expect(socket?.readyState).toBe(1)

      expect(await env.readTextFile('remote/answer.txt')).toEqual({
        ok: true,
        value: '42\n',
      })
      expect(transport.ws).toBe(socket)
      expect(env.calls.map(({ op }) => op)).toEqual(['writeFile', 'readTextFile'])
      expect(await fs.readFile(path.join(workspace, 'remote/answer.txt'), 'utf8')).toBe('42\n')

      await env.cleanup()
      await waitUntil(() => socket?.readyState === 3)
    } finally {
      await env.cleanup()
      await proxy.stop()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }, 15_000)

  test('zero provisioning before the first operation; one ensure for many ops', async () => {
    rig = await buildRig()
    expect(rig.ensureCalls).toBe(0)
    expect(rig.env.attached).toBe(false)

    const write = await rig.env.writeFile('src/app.ts', 'export const answer = 42\n')
    expect(write.ok).toBe(true)
    expect(rig.ensureCalls).toBe(1)
    expect(rig.env.attached).toBe(true)
    expect(rig.env.externalId).toBe('env-box-1')

    // Real bytes on the environment's real filesystem.
    const onDisk = await fs.readFile(path.join(rig.workspace, 'src/app.ts'), 'utf8')
    expect(onDisk).toBe('export const answer = 42\n')

    // Later ops reuse the attachment — no second ensure.
    const read = await rig.env.readTextFile('src/app.ts')
    expect(read).toEqual({ ok: true, value: 'export const answer = 42\n' })
    const run = await rig.env.exec('grep -r answer src && echo FOUND')
    expect(run.ok).toBe(true)
    if (run.ok) {
      expect(run.value.stdout).toContain('FOUND')
      expect(run.value.exitCode).toBe(0)
    }
    expect(rig.ensureCalls).toBe(1)
    // The rpcCalls tap the worker's /say reports.
    expect(rig.env.calls.map((c) => c.op)).toEqual(['writeFile', 'readTextFile', 'exec'])
  })

  test('a missing file is a Result the tool can render, and a dead API is too', async () => {
    rig = await buildRig()
    const missing = await rig.env.readTextFile('never-written.txt')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect((missing.error as { code?: string }).code).toBe('not_found')

    const dead = new LazyKortixEnv({
      apiUrl: 'http://127.0.0.1:1/v1',
      token: WORKER_TOKEN,
      projectId: 'p',
      sessionId: 's',
      cwd: '/workspace',
      ensureTimeoutMs: 1500,
    })
    const result = await dead.exec('echo hi')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(String((result.error as Error).message)).toContain('could not attach environment')
    }
  }, 15_000)

  test('the real worker edit tool reads and writes through the daemon', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-edit-rpc-'))
    const target = path.join(workspace, 'src/app.ts')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'export const answer = 41\n')

    const daemon = new Hono()
    daemon.route(
      '/kortix/env-rpc',
      createEnvRpcRouter({
        sandboxToken: ENVIRONMENT_TOKEN,
        envRpcSecret: RPC_SECRET,
        workspace,
      } as unknown as Config),
    )
    const daemonServer = Bun.serve({ port: 0, fetch: daemon.fetch })
    const worker = await startWorker({
      port: 0,
      envUrl: `http://127.0.0.1:${daemonServer.port}/kortix/env-rpc`,
      envUrlExplicit: true,
      envCwd: workspace,
      envHeaders: {
        'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-box-edit'),
      },
      envTransport: 'fetch',
      systemPrompt: 'Edit the requested file.',
      modelMode: 'faux',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })

    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Change the answer to 42.',
          script: [
            {
              tool: 'edit',
              args: {
                path: 'src/app.ts',
                edits: [{ oldText: 'answer = 41', newText: 'answer = 42' }],
              },
            },
            { text: 'done' },
          ],
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { rpcCalls?: string[] }
      expect(body.rpcCalls).toEqual([
        'absolutePath',
        'absolutePath',
        'canonicalPath',
        'fileInfo',
        'readTextFile',
        'writeFile',
      ])
      expect(await fs.readFile(target, 'utf8')).toBe('export const answer = 42\n')
    } finally {
      await worker.env.cleanup()
      await worker.close()
      daemonServer.stop(true)
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }, 15_000)
})
