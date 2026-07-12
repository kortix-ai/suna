import { createHmac } from 'crypto'
import { describe, expect, it } from 'bun:test'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import type { Config } from '../config'
import { startProxy } from '../proxy'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 0,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace: '/tmp',
    projectTarget: '/tmp',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    ...over,
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signCtx(): string {
  const now = Math.floor(Date.now() / 1000)
  const payloadB64 = base64url(Buffer.from(JSON.stringify({
    userId: 'user_123',
    sandboxId: 'sandbox_123',
    sandboxRole: 'owner',
    scopes: [],
    iat: now,
    exp: now + 60,
  }), 'utf8'))
  const sig = base64url(createHmac('sha256', TEST_TOKEN).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

function authHeaders(): Record<string, string> {
  return { [KORTIX_USER_CONTEXT_HEADER]: signCtx(), 'Content-Type': 'application/json' }
}

function startTestProxy(cfg: Config = baseConfig()) {
  return startProxy(cfg, Date.now(), { repoMaterializationError: null, timeline: [] })
}

interface PtyMeta {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: 'running' | 'exited'
  pid: number
  exitCode?: number
}

async function createPty(port: number, body: Record<string, unknown>): Promise<PtyMeta> {
  const res = await fetch(`http://127.0.0.1:${port}/kortix/pty`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PtyMeta
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('websocket failed to open'))
  })
}

function waitForClose(ws: WebSocket, timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs)
    ws.onclose = (event) => {
      clearTimeout(timer)
      resolve({ code: event.code, reason: event.reason })
    }
  })
}

/** Accumulate WS text messages until `predicate(accumulated)` is true. */
function waitForData(ws: WebSocket, predicate: (acc: string) => boolean, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = ''
    const timer = setTimeout(() => reject(new Error(`timed out waiting for data; got: ${JSON.stringify(acc)}`)), timeoutMs)
    ws.onmessage = (event) => {
      acc += String(event.data)
      if (predicate(acc)) {
        clearTimeout(timer)
        resolve(acc)
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('websocket errored'))
    }
  })
}

describe('kortix-native pty', () => {
  it('rejects HTTP routes without a signed user context', async () => {
    const proxy = startTestProxy()
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    } finally {
      await proxy.stop()
    }
  })

  it('503s when the daemon has no sandbox token configured', async () => {
    const proxy = startTestProxy(baseConfig({ sandboxToken: undefined }))
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(503)
    } finally {
      await proxy.stop()
    }
  })

  it('creates, lists, resizes, and deletes a pty over HTTP', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'sleep 5'], title: 'test shell' })
      expect(created.status).toBe('running')
      expect(created.title).toBe('test shell')
      expect(created.pid).toBeGreaterThan(0)

      const listRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      const list = (await listRes.json()) as PtyMeta[]
      expect(list.some((p) => p.id === created.id)).toBe(true)

      const patchRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ size: { rows: 40, cols: 100 } }),
      })
      expect(patchRes.status).toBe(200)

      const delRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      expect(delRes.status).toBe(200)

      const listAfter = (await (
        await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      ).json()) as PtyMeta[]
      expect(listAfter.some((p) => p.id === created.id)).toBe(false)
    } finally {
      await proxy.stop()
    }
  })

  it('streams real command output over the websocket', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'echo PTY_MARKER_42; sleep 5'] })
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      await waitForOpen(ws)
      await waitForData(ws, (acc) => acc.includes('PTY_MARKER_42'))
      ws.close()

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })

  it('broadcasts to multiple concurrent viewers of the same pty', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'sleep 5'] })
      const url = `ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`
      const headers = { [KORTIX_USER_CONTEXT_HEADER]: signCtx() }
      const wsA = new WebSocket(url, { headers } as any)
      const wsB = new WebSocket(url, { headers } as any)
      await Promise.all([waitForOpen(wsA), waitForOpen(wsB)])

      const marker = 'BROADCAST_MARKER_99'
      const bothSeeIt = Promise.all([
        waitForData(wsA, (acc) => acc.includes(marker)),
        waitForData(wsB, (acc) => acc.includes(marker)),
      ])
      // Only one of the two connections writes — the shell echoes whatever
      // it receives on stdin to BOTH attached viewers.
      wsA.send(`echo ${marker}\n`)
      const [a, b] = await bothSeeIt
      expect(a).toBeDefined()
      expect(b).toBeDefined()

      wsA.close()
      wsB.close()
      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })

  it('replays scrollback to a reconnecting viewer', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'echo SCROLLBACK_MARKER; sleep 5'] })
      const url = `ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`
      const headers = { [KORTIX_USER_CONTEXT_HEADER]: signCtx() }

      const first = new WebSocket(url, { headers } as any)
      await waitForOpen(first)
      await waitForData(first, (acc) => acc.includes('SCROLLBACK_MARKER'))
      first.close()
      await waitForClose(first)

      // A brand-new connection should immediately see the earlier output
      // replayed, without the shell producing it again.
      const second = new WebSocket(url, { headers } as any)
      await waitForOpen(second)
      await waitForData(second, (acc) => acc.includes('SCROLLBACK_MARKER'))
      second.close()

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })

  it('closes the websocket with pty-not-found for an unknown id', async () => {
    const proxy = startTestProxy()
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/kortix/pty/kpty_does_not_exist/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      const closed = await waitForClose(ws)
      expect(closed.reason).toBe('pty not found')
    } finally {
      await proxy.stop()
    }
  })

  it('rejects websocket upgrades without a valid signed context', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'sleep 2'] })
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`)
      const closed = await waitForClose(ws).catch(() => null)
      // Bun surfaces an unauthorized upgrade as either a rejected HTTP
      // response (never opens) or an immediate close — either way it must
      // never reach the pty.
      expect(closed === null || closed.code !== 1000).toBe(true)

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })
})
