import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
    sandboxToken: TEST_TOKEN,
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

  it('GET /file/content is now daemon-served (404 for missing, not an opencode 502)', async () => {
    // The daemon owns reads now — a missing file is a daemon 404, NOT a proxied
    // 502/503 from the dead opencode upstream. Proves reads are intercepted.
    const res = await fetch(`${base}/file/content?path=does-not-exist.md`, { headers: authHeaders() })
    expect(res.status).toBe(404)
  })

  it('GET /file/raw streams exact binary bytes (xlsx mime, no corruption)', async () => {
    // A payload with bytes that don't survive a UTF-8 round-trip, including a
    // NUL — proves we return the raw bytes, not a lossy text re-encode.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x41])
    await fs.writeFile(`${WORKSPACE}/sheet.xlsx`, bytes)

    const res = await fetch(`${base}/file/raw?path=${encodeURIComponent(`${WORKSPACE}/sheet.xlsx`)}`, {
      headers: authHeaders(),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    const out = new Uint8Array(await res.arrayBuffer())
    expect(out.length).toBe(bytes.length)
    expect([...out]).toEqual([...bytes])
  })

  it('GET /file/raw resolves a workspace-relative path', async () => {
    await fs.writeFile(`${WORKSPACE}/deck.pptx`, new Uint8Array([1, 2, 3]))
    const res = await fetch(`${base}/file/raw?path=deck.pptx`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(3)
  })

  it('GET /file/raw is 404 for a missing file and 400 with no path', async () => {
    const missing = await fetch(`${base}/file/raw?path=${encodeURIComponent(`${WORKSPACE}/nope.xlsx`)}`, {
      headers: authHeaders(),
    })
    expect(missing.status).toBe(404)
    const noPath = await fetch(`${base}/file/raw`, { headers: authHeaders() })
    expect(noPath.status).toBe(400)
  })

  it('GET /file/raw rejects path traversal outside allowed roots (403)', async () => {
    const res = await fetch(`${base}/file/raw?path=${encodeURIComponent('/etc/passwd')}`, {
      headers: authHeaders(),
    })
    expect(res.status).toBe(403)
  })

  it('GET /file/raw requires a signed context (401 unauthenticated)', async () => {
    const res = await fetch(`${base}/file/raw?path=${encodeURIComponent(`${WORKSPACE}/sheet.xlsx`)}`)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Read / list / status / find — the daemon owns the full file API. These run
// against a real git repo fixture so `ignored` and `/file/status` are exercised.
// ---------------------------------------------------------------------------
describe('daemon file read + list + status + find routes', () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string
  let WS: string

  const git = (...args: string[]) => execFileSync('git', ['-C', WS, ...args], { stdio: 'pipe' })

  beforeAll(async () => {
    WS = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-read-test-'))
    git('init', '-q')
    git('config', 'user.email', 'test@kortix.ai')
    git('config', 'user.name', 'Kortix Test')

    await fs.writeFile(`${WS}/hello.txt`, 'line one\nline two\n')
    await fs.mkdir(`${WS}/sub`, { recursive: true })
    await fs.writeFile(`${WS}/sub/nested.md`, '# Nested\nsearchable needle here\n')
    await fs.writeFile(`${WS}/.gitignore`, 'ignored.txt\n')
    // Binary by extension (xlsx) + binary by NUL-sniff (unknown .dat extension).
    await fs.writeFile(`${WS}/sheet.xlsx`, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x41]))
    await fs.writeFile(`${WS}/blob.dat`, new Uint8Array([0x01, 0x00, 0xfe, 0xff, 0x02]))
    git('add', '-A')
    git('commit', '-q', '-m', 'init')

    // Now create uncommitted changes for /file/status.
    await fs.writeFile(`${WS}/hello.txt`, 'line one\nline two\nline three\n') // modified
    await fs.writeFile(`${WS}/new.txt`, 'brand new\n') // untracked → added
    await fs.writeFile(`${WS}/ignored.txt`, 'do not track\n') // gitignored

    const cfg: Config = { ...baseConfig(), workspace: WS, projectTarget: WS }
    const app = buildOpencodeApp(cfg, fakeOpencode(), Date.now())
    server = Bun.serve({ port: 0, fetch: app.fetch })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    server?.stop(true)
    if (WS) await fs.rm(WS, { recursive: true, force: true })
  })

  it('GET /file/content returns text as utf8 with a size', async () => {
    const res = await fetch(`${base}/file/content?path=hello.txt`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.type).toBe('text')
    expect(body.content).toBe('line one\nline two\nline three\n')
    expect(body.encoding).toBeUndefined()
    expect(body.size).toBe('line one\nline two\nline three\n'.length)
  })

  it('GET /file/content base64-encodes binary by extension (xlsx) with correct mime', async () => {
    const res = await fetch(`${base}/file/content?path=sheet.xlsx`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.type).toBe('binary')
    expect(body.encoding).toBe('base64')
    expect(body.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect([...Buffer.from(body.content, 'base64')]).toEqual([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x41])
  })

  it('GET /file/content detects binary via NUL-byte sniff for unknown extensions', async () => {
    const res = await fetch(`${base}/file/content?path=blob.dat`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.type).toBe('binary')
    expect(body.encoding).toBe('base64')
    expect([...Buffer.from(body.content, 'base64')]).toEqual([0x01, 0x00, 0xfe, 0xff, 0x02])
  })

  it('GET /file lists a directory with absolute paths and gitignore flags', async () => {
    const res = await fetch(`${base}/file?path=.`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const nodes = (await res.json()) as Array<{ name: string; path: string; absolute: string; type: string; ignored: boolean }>
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))
    expect(byName['hello.txt']).toMatchObject({ type: 'file', ignored: false })
    expect(byName['sub']).toMatchObject({ type: 'directory' })
    expect(byName['ignored.txt']?.ignored).toBe(true)
    expect(byName['.git']?.ignored).toBe(true)
    expect(byName['hello.txt']?.absolute).toBe(path.join(WS, 'hello.txt'))
  })

  it('GET /file/status reports modified + added, excludes ignored', async () => {
    const res = await fetch(`${base}/file/status`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ path: string; status: string; added: number; removed: number }>
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]))
    expect(byPath['hello.txt']?.status).toBe('modified')
    expect(byPath['hello.txt']?.added).toBe(1)
    expect(byPath['new.txt']?.status).toBe('added')
    expect(byPath['ignored.txt']).toBeUndefined()
  })

  it('GET /find/file fuzzy-matches by name', async () => {
    const res = await fetch(`${base}/find/file?query=nested`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const paths = (await res.json()) as string[]
    expect(paths).toContain('sub/nested.md')
  })

  it('GET /find returns text matches (ripgrep or Node fallback)', async () => {
    const res = await fetch(`${base}/find?pattern=needle`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const matches = (await res.json()) as Array<{ path: string; line_number: number; lines: string }>
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some((m) => m.path.endsWith('nested.md') && m.lines.includes('needle'))).toBe(true)
  })

  it('read/list/find require a signed context (401 unauthenticated)', async () => {
    expect((await fetch(`${base}/file?path=.`)).status).toBe(401)
    expect((await fetch(`${base}/file/status`)).status).toBe(401)
    expect((await fetch(`${base}/find?pattern=x`)).status).toBe(401)
  })
})
