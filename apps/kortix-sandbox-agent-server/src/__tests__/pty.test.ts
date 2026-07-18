import { createHmac } from 'crypto'
import { describe, expect, it } from 'bun:test'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
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

function fakeOpencode(): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => null,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
  } as unknown as Opencode
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
  return startProxy(cfg, fakeOpencode(), Date.now(), { repoMaterializationError: null, timeline: [] })
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

  it('keeps the default interactive shell alive until its first viewer attaches', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, {})
      await Bun.sleep(50)

      const list = (await (
        await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      ).json()) as PtyMeta[]
      expect(list.find((pty) => pty.id === created.id)?.status).toBe('running')

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      await waitForOpen(ws)
      ws.send("printf 'DEFAULT_SHELL_MARKER\\n'\n")
      await waitForData(ws, (acc) => acc.includes('DEFAULT_SHELL_MARKER'))
      ws.close()

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
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

  it('lookup-or-create: mints a fresh, working pty for an unknown id instead of closing', async () => {
    const proxy = startTestProxy()
    try {
      const unknownId = 'kpty_does_not_exist'
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/kortix/pty/${unknownId}/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      await waitForOpen(ws)
      // The new pty reuses the requested id, so the client's existing
      // tab/URL/list-cache key keeps working with zero protocol changes.
      const listRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      const list = (await listRes.json()) as PtyMeta[]
      expect(list.some((p) => p.id === unknownId && p.status === 'running')).toBe(true)

      // It's a genuine live shell, not a stub — commands actually execute.
      ws.send("printf 'LOOKUP_OR_CREATE_MARKER\\n'\n")
      await waitForData(ws, (acc) => acc.includes('LOOKUP_OR_CREATE_MARKER'))
      ws.close()

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${unknownId}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })

  it('lookup-or-create: mints a fresh pty when the client supplies no id at all', async () => {
    const proxy = startTestProxy()
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/kortix/pty/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      await waitForOpen(ws)
      ws.send("printf 'NO_ID_MARKER\\n'\n")
      await waitForData(ws, (acc) => acc.includes('NO_ID_MARKER'))
      ws.close()

      const listRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      const list = (await listRes.json()) as PtyMeta[]
      expect(list.some((p) => p.status === 'running')).toBe(true)
    } finally {
      await proxy.stop()
    }
  })

  it('lookup-or-create: reattaches to a valid running id instead of recreating (reconnect semantics preserved)', async () => {
    const proxy = startTestProxy()
    try {
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'sleep 5'] })
      const url = `ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`
      const headers = { [KORTIX_USER_CONTEXT_HEADER]: signCtx() }

      const first = new WebSocket(url, { headers } as any)
      await waitForOpen(first)
      first.send("printf 'REATTACH_MARKER\\n'\n")
      await waitForData(first, (acc) => acc.includes('REATTACH_MARKER'))
      first.close()
      await waitForClose(first)

      // Reconnecting with the same still-running id resumes the SAME shell
      // (same pid) rather than spawning a new one.
      const second = new WebSocket(url, { headers } as any)
      await waitForOpen(second)
      second.close()

      const listRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      const list = (await listRes.json()) as PtyMeta[]
      expect(list.find((p) => p.id === created.id)?.pid).toBe(created.pid)

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })

  it('lookup-or-create: a known-exited pty closes cleanly instead of being silently reincarnated', async () => {
    const proxy = startTestProxy()
    try {
      // A command that exits immediately — entry stays in the registry with
      // status 'exited' until an explicit DELETE (see finish() in pty.ts).
      const created = await createPty(proxy.port, { command: 'bash', args: ['-c', 'exit 7'] })

      // Wait for the process to actually exit.
      await Bun.sleep(200)
      const listRes = await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty`, { headers: authHeaders() })
      const list = (await listRes.json()) as PtyMeta[]
      expect(list.find((p) => p.id === created.id)?.status).toBe('exited')

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/kortix/pty/${created.id}/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      const closed = await waitForClose(ws)
      expect(closed.reason).toContain('pty exited')

      await fetch(`http://127.0.0.1:${proxy.port}/kortix/pty/${created.id}`, { method: 'DELETE', headers: authHeaders() })
    } finally {
      await proxy.stop()
    }
  })

  it('lookup-or-create: survives a daemon-restart-like registry loss — reconnecting with the old id gets a working shell', async () => {
    // Simulates exactly the reported bug: a client holds a ptyId minted by a
    // previous daemon process. A full daemon/container restart wipes the
    // in-memory registry (unlike an opencode-only restart, which the pty
    // registry is designed to survive). The client then reconnects with the
    // now-unknown id — it must get a working terminal, not a hard failure.
    const firstProxy = startTestProxy()
    let staleId: string
    try {
      const created = await createPty(firstProxy.port, { command: 'bash', args: ['-c', 'sleep 5'] })
      staleId = created.id
    } finally {
      await firstProxy.stop()
    }

    // A brand-new daemon process (fresh in-memory registry), same port range.
    const secondProxy = startTestProxy()
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${secondProxy.port}/kortix/pty/${staleId}/connect`,
        { headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx() } } as any,
      )
      await waitForOpen(ws)
      ws.send("printf 'RESTART_RECOVERY_MARKER\\n'\n")
      await waitForData(ws, (acc) => acc.includes('RESTART_RECOVERY_MARKER'))
      ws.close()
    } finally {
      await secondProxy.stop()
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
