import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'

const TEST_TOKEN = 'files-test-kortix-token'

// A workspace under the OS temp dir. /tmp is one of the daemon's ALLOWED_ROOTS,
// so uploads/mkdir/rename/delete resolve and pass path validation.
let WORKSPACE: string

function baseConfig(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace: WORKSPACE,
    projectTarget: WORKSPACE,
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
    kortixToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
  }
}

// opencode that always reports "ok" but points at a dead port — proves the
// file write routes never touch opencode (they're handled by the daemon).
function fakeOpencode(): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => 123,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
  } as unknown as Opencode
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Mint a valid X-Kortix-User-Context header signed with TEST_TOKEN. */
function signContext(): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(
    JSON.stringify({
      userId: 'user-1',
      sandboxId: 'sandbox-1',
      sandboxRole: 'owner',
      scopes: [],
      iat: now,
      exp: now + 3600,
    }),
  )
  const sig = createHmac('sha256', TEST_TOKEN).update(payload).digest()
  const sigB64 = sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${payload}.${sigB64}`
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [KORTIX_USER_CONTEXT_HEADER]: signContext(), ...extra }
}

describe('daemon file write routes', () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string

  beforeAll(async () => {
    WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-files-test-'))
    const app = buildOpencodeApp(baseConfig(), fakeOpencode(), Date.now())
    server = Bun.serve({ port: 0, fetch: app.fetch })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    server?.stop(true)
    if (WORKSPACE) await fs.rm(WORKSPACE, { recursive: true, force: true })
  })

  it('rejects unauthenticated upload (no signed context)', async () => {
    const form = new FormData()
    form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
    const res = await fetch(`${base}/file/upload`, { method: 'POST', body: form })
    expect(res.status).toBe(401)
  })

  it('uploads a file via the `path` + `file` convention', async () => {
    const form = new FormData()
    form.append('path', `${WORKSPACE}/uploads`)
    form.append('file', new File(['hello world'], 'notes.txt', { type: 'text/plain' }))
    const res = await fetch(`${base}/file/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    expect(res.status).toBe(200)
    const results = (await res.json()) as { path: string; size: number }[]
    expect(results).toHaveLength(1)
    expect(results[0]!.path).toBe(`${WORKSPACE}/uploads/notes.txt`)
    expect(results[0]!.size).toBe('hello world'.length)
    const onDisk = await fs.readFile(results[0]!.path, 'utf8')
    expect(onDisk).toBe('hello world')
  })

  it('auto-suffixes on filename collision (never overwrites)', async () => {
    const upload = async () => {
      const form = new FormData()
      form.append('path', `${WORKSPACE}/uploads`)
      form.append('file', new File(['v'], 'dup.txt', { type: 'text/plain' }))
      const res = await fetch(`${base}/file/upload`, { method: 'POST', headers: authHeaders(), body: form })
      return (await res.json()) as { path: string }[]
    }
    const first = await upload()
    const second = await upload()
    expect(first[0]!.path).toBe(`${WORKSPACE}/uploads/dup.txt`)
    expect(second[0]!.path).not.toBe(first[0]!.path)
    expect(second[0]!.path).toMatch(/dup-.*\.txt$/)
  })

  it('uploads via the field-name-as-path convention', async () => {
    const form = new FormData()
    form.append(`${WORKSPACE}/nested/deep/file.md`, new File(['# hi'], 'file.md'), 'file.md')
    const res = await fetch(`${base}/file/upload`, { method: 'POST', headers: authHeaders(), body: form })
    expect(res.status).toBe(200)
    const results = (await res.json()) as { path: string }[]
    expect(results[0]!.path).toBe(`${WORKSPACE}/nested/deep/file.md`)
    expect(await fs.readFile(results[0]!.path, 'utf8')).toBe('# hi')
  })

  it('blocks path traversal outside allowed roots', async () => {
    const form = new FormData()
    form.append('path', '/etc')
    form.append('file', new File(['x'], 'passwd', { type: 'text/plain' }))
    const res = await fetch(`${base}/file/upload`, { method: 'POST', headers: authHeaders(), body: form })
    expect(res.status).toBe(403)
  })

  it('mkdir creates a directory', async () => {
    const res = await fetch(`${base}/file/mkdir`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: `${WORKSPACE}/newdir` }),
    })
    expect(res.status).toBe(200)
    const stat = await fs.stat(`${WORKSPACE}/newdir`)
    expect(stat.isDirectory()).toBe(true)
  })

  it('renames/moves a file', async () => {
    await fs.writeFile(`${WORKSPACE}/src.txt`, 'move me')
    const res = await fetch(`${base}/file/rename`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ from: `${WORKSPACE}/src.txt`, to: `${WORKSPACE}/moved/dest.txt` }),
    })
    expect(res.status).toBe(200)
    expect(await fs.readFile(`${WORKSPACE}/moved/dest.txt`, 'utf8')).toBe('move me')
    await expect(fs.stat(`${WORKSPACE}/src.txt`)).rejects.toThrow()
  })

  it('deletes a file', async () => {
    await fs.writeFile(`${WORKSPACE}/gone.txt`, 'bye')
    const res = await fetch(`${base}/file`, {
      method: 'DELETE',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: `${WORKSPACE}/gone.txt` }),
    })
    expect(res.status).toBe(200)
    await expect(fs.stat(`${WORKSPACE}/gone.txt`)).rejects.toThrow()
  })

  it('delete returns 404 for a missing path', async () => {
    const res = await fetch(`${base}/file`, {
      method: 'DELETE',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: `${WORKSPACE}/does-not-exist.txt` }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /file/content still falls through to opencode (not intercepted)', async () => {
    // opencode points at a dead port, so a proxied read yields 502/503 — but
    // crucially NOT a daemon file-route response. Proves reads aren't captured.
    const res = await fetch(`${base}/file/content?path=README.md`, { headers: authHeaders() })
    expect([502, 503]).toContain(res.status)
  })
})
