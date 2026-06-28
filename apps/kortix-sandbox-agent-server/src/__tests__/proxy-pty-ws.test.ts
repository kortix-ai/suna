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
    workspace: '/workspace',
    projectTarget: '/workspace',
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

function fakeOpencode(internalUrl: string): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => null,
    getInternalUrl: () => internalUrl,
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

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('websocket failed to open'))
  })
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.onmessage = (event) => resolve(String(event.data))
    ws.onerror = () => reject(new Error('websocket errored before message'))
  })
}

function startEchoUpstream() {
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/pty/pty_test/connect' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const upgraded = server.upgrade(req)
        if (upgraded) return undefined
        return new Response('upgrade failed', { status: 500 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${String(message)}`)
      },
    },
  })
}

function startTicketedEchoUpstream() {
  const tickets = new Set<string>()
  let sawDirectoryHeader = false
  let sawPrivateAuthParam = false

  const server = Bun.serve({
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/pty/pty_test/connect-token' && req.method === 'POST') {
        if (req.headers.get('x-opencode-ticket') !== '1') {
          return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
        }
        sawDirectoryHeader = req.headers.get('x-opencode-directory') === '/workspace'
        const ticket = 'ticket_123'
        tickets.add(ticket)
        return Response.json({ ticket, expires_in: 60 })
      }
      if (url.pathname === '/pty/pty_test/connect' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        sawPrivateAuthParam = url.searchParams.has('__kortix_user_context')
        if (!tickets.delete(url.searchParams.get('ticket') ?? '')) {
          return new Response('forbidden', { status: 403 })
        }
        if (url.searchParams.get('cursor') !== '-1') {
          return new Response('missing cursor', { status: 400 })
        }
        if (req.headers.get('x-opencode-directory') !== '/workspace') {
          return new Response('missing directory', { status: 400 })
        }
        const upgraded = server.upgrade(req)
        if (upgraded) return undefined
        return new Response('upgrade failed', { status: 500 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${String(message)}`)
      },
    },
  })

  return {
    server,
    sawDirectoryHeader: () => sawDirectoryHeader,
    sawPrivateAuthParam: () => sawPrivateAuthParam,
  }
}

async function expectEcho(proxyPort: number, opts: { query?: string; headers?: Record<string, string> } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/pty/pty_test/connect${opts.query ?? ''}`, {
    headers: opts.headers ?? { [KORTIX_USER_CONTEXT_HEADER]: signCtx() },
  } as any)

  await waitForOpen(ws)
  const message = waitForMessage(ws)
  ws.send('ping')
  expect(await message).toBe('echo:ping')
  ws.close()
}

describe('daemon PTY websocket bridge', () => {
  it('bridges signed /pty websocket traffic to loopback opencode', async () => {
    const upstream = startEchoUpstream()

    const proxy = startProxy(
      baseConfig(),
      fakeOpencode(`http://127.0.0.1:${upstream.port}`),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    )

    try {
      await expectEcho(proxy.port)
    } finally {
      await proxy.stop()
      upstream.stop(true)
    }
  })

  it('mints and consumes opencode PTY websocket tickets when supported', async () => {
    const upstream = startTicketedEchoUpstream()

    const proxy = startProxy(
      baseConfig(),
      fakeOpencode(`http://127.0.0.1:${upstream.server.port}`),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    )

    try {
      await expectEcho(proxy.port)
      expect(upstream.sawDirectoryHeader()).toBe(true)
      expect(upstream.sawPrivateAuthParam()).toBe(false)
    } finally {
      await proxy.stop()
      upstream.server.stop(true)
    }
  })

  it('accepts signed user context in the websocket query for Platinum edge upgrades', async () => {
    const upstream = startTicketedEchoUpstream()

    const proxy = startProxy(
      baseConfig(),
      fakeOpencode(`http://127.0.0.1:${upstream.server.port}`),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    )

    try {
      await expectEcho(proxy.port, {
        query: `?__kortix_user_context=${encodeURIComponent(signCtx())}`,
        headers: {},
      })
      expect(upstream.sawDirectoryHeader()).toBe(true)
      expect(upstream.sawPrivateAuthParam()).toBe(false)
    } finally {
      await proxy.stop()
      upstream.server.stop(true)
    }
  })

  it('uses the reloaded sandbox token for restored warm-snapshot websocket traffic', async () => {
    const upstream = startEchoUpstream()

    const proxy = startProxy(
      baseConfig({ sandboxToken: undefined }),
      fakeOpencode(`http://127.0.0.1:${upstream.port}`),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    )

    try {
      proxy.reload(baseConfig())
      await expectEcho(proxy.port)
    } finally {
      await proxy.stop()
      upstream.stop(true)
    }
  })
})
