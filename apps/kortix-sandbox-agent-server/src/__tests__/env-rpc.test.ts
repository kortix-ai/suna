import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { createEnvRpcRouter, environmentRpcSecret } from '../routes/env-rpc'

const TOKEN = 'test-session-token'
const RPC_SECRET = 'test-environment-rpc-secret'

function mintUserContext(secret: string, expOffsetSec = 300): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: 'worker',
      sandboxId: 'env-box',
      sandboxRole: 'owner',
      scopes: [],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    }),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const sig = createHmac('sha256', secret)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${payload}.${sig}`
}

async function makeApp() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'env-rpc-ws-'))
  const app = createEnvRpcRouter({
    sandboxToken: TOKEN,
    envRpcSecret: RPC_SECRET,
    workspace,
  } as unknown as Config)
  const call = async (op: string, args: Record<string, unknown>, opts?: { token?: string }) => {
    const res = await app.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [KORTIX_USER_CONTEXT_HEADER]: mintUserContext(opts?.token ?? RPC_SECRET),
      },
      body: JSON.stringify({ op, args, cwd: workspace }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  return { workspace, app, call }
}

describe('env-rpc route', () => {
  test('prefers the purpose-bound secret and keeps the legacy token fallback', () => {
    expect(environmentRpcSecret({ envRpcSecret: RPC_SECRET, sandboxToken: TOKEN })).toBe(
      RPC_SECRET,
    )
    expect(environmentRpcSecret({ sandboxToken: TOKEN })).toBe(TOKEN)
  })

  test('rejects a missing or wrongly-signed user context', async () => {
    const { app } = await makeApp()
    const noHeader = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'exists', args: { path: 'x' } }),
    })
    expect(noHeader.status).toBe(401)
    const { call } = await makeApp()
    const wrong = await call('exists', { path: 'x' }, { token: 'other-secret' })
    expect(wrong.status).toBe(401)
    const environmentPat = await call('exists', { path: 'x' }, { token: TOKEN })
    expect(environmentPat.status).toBe(401)
  })

  test('file ops round-trip on the real filesystem, failures are Results not 500s', async () => {
    const { call, workspace } = await makeApp()
    const write = await call('writeFile', { path: 'notes/hello.txt', content: 'hi worker' })
    expect(write.body.ok).toBe(true)
    const read = await call('readTextFile', { path: 'notes/hello.txt' })
    expect(read.body).toEqual({ ok: true, value: 'hi worker' })
    const lines = await call('readTextLines', { path: 'notes/hello.txt', maxLines: 1 })
    expect(lines.body.value).toEqual(['hi worker'])
    const info = await call('fileInfo', { path: 'notes/hello.txt' })
    expect(info.body.value).toMatchObject({
      name: 'hello.txt',
      path: path.join(workspace, 'notes/hello.txt'),
      kind: 'file',
      size: 9,
    })
    expect(info.body.value.mtimeMs).toBeNumber()
    const list = await call('listDir', { path: 'notes' })
    expect(list.body.value).toHaveLength(1)
    expect(list.body.value[0]).toMatchObject({
      name: 'hello.txt',
      path: path.join(workspace, 'notes/hello.txt'),
      kind: 'file',
      size: 9,
    })
    expect(list.body.value[0].mtimeMs).toBeNumber()
    const abs = await call('absolutePath', { path: 'notes/hello.txt' })
    expect(abs.body.value).toBe(path.join(workspace, 'notes/hello.txt'))

    // A missing file is a Result with the errno code — the tool renders it.
    const missing = await call('readTextFile', { path: 'nope.txt' })
    expect(missing.status).toBe(200)
    expect(missing.body.ok).toBe(false)
    expect(missing.body.error.code).toBe('ENOENT')

    const rename = await call('renameFile', {
      sourcePath: 'notes/hello.txt',
      destinationPath: 'notes/renamed.txt',
    })
    expect(rename.body.ok).toBe(true)
    const gone = await call('exists', { path: 'notes/hello.txt' })
    expect(gone.body.value).toBe(false)
  })

  test('preserves symlinks, dangling entries, and line semantics from the Pi filesystem contract', async () => {
    const { call, workspace } = await makeApp()
    await fs.mkdir(path.join(workspace, 'tree'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'tree', 'lines.txt'), 'one\ntwo\n')
    await fs.symlink('missing-target', path.join(workspace, 'tree', 'dangling.txt'))

    const lines = await call('readTextLines', { path: 'tree/lines.txt' })
    expect(lines.body.value).toEqual(['one', 'two'])

    const info = await call('fileInfo', { path: 'tree/dangling.txt' })
    expect(info.body.value).toMatchObject({
      name: 'dangling.txt',
      path: path.join(workspace, 'tree', 'dangling.txt'),
      kind: 'symlink',
    })

    const exists = await call('exists', { path: 'tree/dangling.txt' })
    expect(exists.body).toEqual({ ok: true, value: true })

    const list = await call('listDir', { path: 'tree' })
    expect(list.body.value.find((entry: { name: string }) => entry.name === 'dangling.txt')).toMatchObject({
      path: path.join(workspace, 'tree', 'dangling.txt'),
      kind: 'symlink',
    })
  })

  test('exec runs a real shell in the workspace and reports exit codes', async () => {
    const { call } = await makeApp()
    await call('writeFile', { path: 'probe.txt', content: 'exec sees the workspace' })
    const run = await call('exec', { command: 'cat probe.txt && echo done' })
    expect(run.body.ok).toBe(true)
    expect(run.body.value.stdout).toContain('exec sees the workspace')
    expect(run.body.value.stdout).toContain('done')
    expect(run.body.value.exitCode).toBe(0)

    const fail = await call('exec', { command: 'exit 3' })
    expect(fail.body.value.exitCode).toBe(3)

    const timeoutStartedAt = Date.now()
    const timedOut = await call('exec', {
      command: "bash -c 'sleep 5 & wait'",
      timeout: 200,
    })
    expect(timedOut.body.value.exitCode).not.toBe(0)
    expect(timedOut.body.value.stderr).toContain('killed')
    expect(Date.now() - timeoutStartedAt).toBeLessThan(1_500)
  })

  test('an unknown op is a Result, never a crash', async () => {
    const { call } = await makeApp()
    const bogus = await call('formatDisk', {})
    expect(bogus.status).toBe(200)
    expect(bogus.body.ok).toBe(false)
    expect(bogus.body.error.code).toBe('unknown_op')
  })
})
