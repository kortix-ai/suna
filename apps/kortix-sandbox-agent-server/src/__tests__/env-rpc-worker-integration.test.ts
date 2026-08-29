import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

import type { Config } from '../config'
import { createEnvRpcRouter } from '../routes/env-rpc'
// The worker half, imported from its real sources (apps/kortix-worker is
// workspace-excluded but dependency-free on this path — `ws` loads lazily).
import { LazyKortixEnv } from '../../../kortix-worker/src/lazy-env.ts'

const TOKEN = 'shared-session-token'

interface Rig {
  stop(): Promise<void>
  ensureCalls: number
  workspace: string
  env: LazyKortixEnv
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
  daemon.route('/kortix/env-rpc', createEnvRpcRouter({ sandboxToken: TOKEN, workspace } as unknown as Config))
  const daemonServer = Bun.serve({ port: 0, fetch: daemon.fetch })

  const rig = { ensureCalls: 0 } as Rig
  const api = new Hono()
  api.post('/v1/projects/:pid/sessions/:sid/environment/ensure', (c) => {
    rig.ensureCalls += 1
    if (c.req.header('authorization') !== `Bearer ${TOKEN}`) {
      return c.json({ error: 'bad token' }, 401)
    }
    return c.json({
      session_id: c.req.param('sid'),
      status: 'active',
      external_id: 'env-box-1',
      preview_url: `http://127.0.0.1:${daemonServer.port}`,
      preview_token: 'edge-token',
    })
  })
  const apiServer = Bun.serve({ port: 0, fetch: api.fetch })

  rig.workspace = workspace
  rig.env = new LazyKortixEnv({
    apiUrl: `http://127.0.0.1:${apiServer.port}/v1`,
    token: TOKEN,
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
    if (!missing.ok) expect((missing.error as { code?: string }).code).toBe('ENOENT')

    const dead = new LazyKortixEnv({
      apiUrl: 'http://127.0.0.1:1/v1',
      token: TOKEN,
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
})
