import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildOpencodeApp } from '../proxy'

const TOKEN = 'import-test-token'
const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222'
const bytes = new TextEncoder().encode('verified attachment')
const sha256 = createHash('sha256').update(bytes).digest('hex')
let workspace = ''
let originalFetch: typeof fetch

function config(overrides: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace,
    projectTarget: workspace,
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: '33333333-3333-4333-8333-333333333333',
    apiUrl: 'http://api.test',
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    compiledBootMode: 'off',
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
    ...overrides,
  }
}

function opencode(): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => 1,
    getActivePort: () => 4096,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
  } as unknown as Opencode
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signedContext(): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(
    JSON.stringify({
      userId: 'user-1',
      sandboxId: 'sandbox-1',
      sandboxRole: 'owner',
      scopes: [],
      iat: now,
      exp: now + 60,
    }),
  )
  return `${payload}.${b64url(createHmac('sha256', TOKEN).update(payload).digest())}`
}

function targetPath() {
  return path.join(workspace, 'uploads/.kortix-inbox', COMMAND_ID, '0-proof.txt')
}

function descriptor(downloadUrl = 'http://storage.test/signed?token=secret') {
  return {
    version: 1,
    command_id: COMMAND_ID,
    attachment_id: ATTACHMENT_ID,
    part_index: 0,
    filename: 'proof.txt',
    mime: 'text/plain',
    size_bytes: bytes.byteLength,
    sha256,
    target_path: targetPath(),
    download_url: downloadUrl,
    download_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }
}

function request(app: ReturnType<typeof buildOpencodeApp>, body: Record<string, unknown>) {
  return app.request('http://daemon.test/file/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [KORTIX_USER_CONTEXT_HEADER]: signedContext(),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /file/import', () => {
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-import-test-'))
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('pulls a server-bound descriptor and writes verified bytes atomically', async () => {
    const seen: Array<{ url: string; authorization: string | null; redirect: RequestInit['redirect'] }> = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        seen.push({ url, authorization: headers.get('authorization'), redirect: init?.redirect })
        if (url.startsWith('http://api.test/v1/projects/')) return Response.json(descriptor())
        if (url.startsWith('http://storage.test/')) return new Response(bytes)
        throw new Error(`unexpected fetch ${url}`)
      },
      { preconnect: originalFetch.preconnect },
    )
    const app = buildOpencodeApp(config(), opencode(), Date.now())

    const response = await request(app, {
      command_id: COMMAND_ID,
      attachment_id: ATTACHMENT_ID,
      part_index: 0,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ path: targetPath(), size: bytes.byteLength, sha256 })
    expect(await fs.readFile(targetPath())).toEqual(Buffer.from(bytes))
    expect(seen).toEqual([
      {
        url: `http://api.test/v1/projects/${config().projectId}/runtime/prompt-attachments/${ATTACHMENT_ID}?command_id=${COMMAND_ID}&part_index=0`,
        authorization: `Bearer ${TOKEN}`,
        redirect: 'error',
      },
      {
        url: 'http://storage.test/signed?token=secret',
        authorization: null,
        redirect: 'error',
      },
    ])
    expect((await fs.readdir(path.dirname(targetPath()))).sort()).toEqual(['0-proof.txt'])
  })

  it('rejects every caller-controlled network, path, and metadata field', async () => {
    let calls = 0
    globalThis.fetch = Object.assign(async () => {
      calls += 1
      return Response.json(descriptor())
    }, { preconnect: originalFetch.preconnect })
    const app = buildOpencodeApp(config(), opencode(), Date.now())

    for (const key of ['url', 'target_path', 'headers', 'filename', 'mime', 'size', 'sha256']) {
      const response = await request(app, {
        command_id: COMMAND_ID,
        attachment_id: ATTACHMENT_ID,
        part_index: 0,
        [key]: key === 'headers' ? { Authorization: 'Bearer stolen' } : 'attacker-value',
      })
      expect(response.status).toBe(400)
    }
    for (const body of [
      {},
      { command_id: COMMAND_ID, attachment_id: ATTACHMENT_ID },
      { command_id: 'not-a-uuid', attachment_id: ATTACHMENT_ID, part_index: 0 },
      { command_id: COMMAND_ID, attachment_id: ATTACHMENT_ID, part_index: -1 },
      { command_id: COMMAND_ID, attachment_id: ATTACHMENT_ID, part_index: 0.5 },
    ]) {
      expect((await request(app, body)).status).toBe(400)
    }
    expect(calls).toBe(0)
  })

  it('removes the temporary file after a digest mismatch', async () => {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) =>
        String(input).startsWith('http://api.test/')
          ? Response.json({ ...descriptor(), sha256: 'f'.repeat(64) })
          : new Response(bytes),
      { preconnect: originalFetch.preconnect },
    )
    const response = await request(buildOpencodeApp(config(), opencode(), Date.now()), {
      command_id: COMMAND_ID,
      attachment_id: ATTACHMENT_ID,
      part_index: 0,
    })

    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('token=secret')
    expect(await fs.readdir(path.dirname(targetPath()))).toEqual([])
  })

  it('rejects expired and oversized descriptors before downloading', async () => {
    for (const invalid of [
      { download_expires_at: new Date(Date.now() - 1).toISOString() },
      { size_bytes: 50 * 1024 * 1024 + 1 },
      { attachment_id: '33333333-3333-4333-8333-333333333333' },
      { target_path: path.join(workspace, 'outside.txt') },
    ]) {
      const calls: string[] = []
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          calls.push(String(input))
          return Response.json({ ...descriptor(), ...invalid })
        },
        { preconnect: originalFetch.preconnect },
      )
      const response = await request(buildOpencodeApp(config(), opencode(), Date.now()), {
        command_id: COMMAND_ID,
        attachment_id: ATTACHMENT_ID,
        part_index: 0,
      })

      expect(response.status).toBe(502)
      expect(calls).toHaveLength(1)
    }
  })

  it('rejects descriptor and download redirects or non-success responses', async () => {
    for (const failure of ['descriptor-redirect', 'descriptor-error', 'download-redirect', 'download-error']) {
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = String(input)
          if (url.startsWith('http://api.test/')) {
            if (failure === 'descriptor-redirect') return Response.redirect('http://attacker.test/', 302)
            if (failure === 'descriptor-error') return Response.json({ error: 'denied' }, { status: 403 })
            return Response.json(descriptor())
          }
          if (failure === 'download-redirect') return Response.redirect('http://attacker.test/', 302)
          return new Response('failed', { status: 503 })
        },
        { preconnect: originalFetch.preconnect },
      )
      const response = await request(buildOpencodeApp(config(), opencode(), Date.now()), {
        command_id: COMMAND_ID,
        attachment_id: ATTACHMENT_ID,
        part_index: 0,
      })

      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('attacker.test')
    }
  })

  it('rejects a declared or streamed body larger than the descriptor', async () => {
    for (const download of [
      new Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength + 1) } }),
      new Response(new Uint8Array([...bytes, 0])),
    ]) {
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) =>
          String(input).startsWith('http://api.test/') ? Response.json(descriptor()) : download,
        { preconnect: originalFetch.preconnect },
      )
      const response = await request(buildOpencodeApp(config(), opencode(), Date.now()), {
        command_id: COMMAND_ID,
        attachment_id: ATTACHMENT_ID,
        part_index: 0,
      })

      expect(response.status).toBe(502)
      expect(await fs.stat(targetPath()).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.readdir(path.dirname(targetPath())).catch(() => [])).toEqual([])
    }
  })

  it('does not download again when the existing file matches size and digest', async () => {
    await fs.mkdir(path.dirname(targetPath()), { recursive: true })
    await fs.writeFile(targetPath(), bytes)
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input))
        return Response.json(descriptor())
      },
      { preconnect: originalFetch.preconnect },
    )
    const response = await request(buildOpencodeApp(config(), opencode(), Date.now()), {
      command_id: COMMAND_ID,
      attachment_id: ATTACHMENT_ID,
      part_index: 0,
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(await fs.readFile(targetPath())).toEqual(Buffer.from(bytes))
  })

  it('fails an HTTPS descriptor that attempts an HTTP download downgrade', async () => {
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input))
        return Response.json(descriptor('http://storage.test/signed?token=secret'))
      },
      { preconnect: originalFetch.preconnect },
    )
    const app = buildOpencodeApp(config({ apiUrl: 'https://api.test/v1' }), opencode(), Date.now())
    const response = await request(app, {
      command_id: COMMAND_ID,
      attachment_id: ATTACHMENT_ID,
      part_index: 0,
    })

    expect(response.status).toBe(502)
    expect(calls).toEqual([
      `https://api.test/v1/projects/${config().projectId}/runtime/prompt-attachments/${ATTACHMENT_ID}?command_id=${COMMAND_ID}&part_index=0`,
    ])
    expect(await response.text()).not.toContain('storage.test')
  })

  it('rejects a symlinked command parent before creating a temporary file', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-import-outside-'))
    try {
      await fs.mkdir(path.join(workspace, 'uploads'), { recursive: true })
      await fs.symlink(outside, path.join(workspace, 'uploads', '.kortix-inbox'))
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) =>
          String(input).startsWith('http://api.test/')
            ? Response.json(descriptor())
            : new Response(bytes),
        { preconnect: originalFetch.preconnect },
      )
      const response = await request(buildOpencodeApp(config(), opencode(), Date.now()), {
        command_id: COMMAND_ID,
        attachment_id: ATTACHMENT_ID,
        part_index: 0,
      })

      expect(response.status).toBe(502)
      expect(await fs.readdir(path.join(outside, COMMAND_ID))).toEqual([])
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
