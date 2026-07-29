import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

import type { AcpConnection, AcpStreamEvent, JsonRpcEnvelope } from '../acp/connection'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { createAcpRouter, createOpenCodeSessionHistory } from './acp'

const TOKEN = 'test-kortix-token-32-chars-1234567890'

function config(sandboxToken: string | null = TOKEN): Config {
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
    projectId: 'project',
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: sandboxToken ?? undefined,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
  }
}

function base64url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function signedContext(secret = TOKEN): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        userId: 'user',
        sandboxId: 'sandbox',
        sandboxRole: 'owner',
        scopes: [],
        iat: now,
        exp: now + 60,
      }),
    ),
  )
  const signature = base64url(
    createHmac('sha256', secret).update(payload).digest(),
  )
  return `${payload}.${signature}`
}

function connection(overrides: {
  ready?: boolean
  lastEventId?: number
  post?: (envelope: JsonRpcEnvelope) => Promise<void>
  subscribe?: (
    after: number,
    event: (value: AcpStreamEvent) => void,
    close?: () => void,
  ) => () => void
} = {}): AcpConnection {
  return {
    ready: overrides.ready ?? true,
    lastEventId: overrides.lastEventId ?? 0,
    post: overrides.post ?? (async () => {}),
    subscribe:
      overrides.subscribe ??
      ((_after, _event, _close) => {
        return () => {}
      }),
  } as unknown as AcpConnection
}

function request(
  app: ReturnType<typeof createAcpRouter>,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers)
  headers.set(KORTIX_USER_CONTEXT_HEADER, signedContext())
  return app.request(`http://localhost${path}`, { ...init, headers })
}

describe('authenticated OpenCode ACP bridge', () => {
  test('rejects missing and invalid sandbox user context', async () => {
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
    )

    const missing = await app.request('http://localhost/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(missing.status).toBe(401)

    const invalid = await app.request('http://localhost/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [KORTIX_USER_CONTEXT_HEADER]: 'invalid',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(invalid.status).toBe(401)
  })

  test('fails closed when the sandbox token is missing', async () => {
    const app = createAcpRouter(
      config(null),
      () => connection(),
      () => 'session',
    )
    const response = await app.request('http://localhost/session')
    expect(response.status).toBe(503)
  })

  test('returns 503 until the initialized ACP connection is ready', async () => {
    const app = createAcpRouter(
      config(),
      () => connection({ ready: false }),
      () => 'session',
    )
    const response = await request(app, '/session')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'OpenCode ACP not ready' })
  })

  test('accepts one JSON-RPC request without waiting for its response', async () => {
    const seen: JsonRpcEnvelope[] = []
    const app = createAcpRouter(
      config(),
      () =>
        connection({
          post: async (envelope) => {
            seen.push(envelope)
          },
        }),
      () => 'session',
    )

    const response = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/load',
        params: { sessionId: 'session' },
      }),
    })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
    expect(seen).toHaveLength(1)
  })

  test('handles session revert and unrevert through the native OpenCode history service', async () => {
    const calls: Array<{
      method: string
      sessionId: string
      messageId?: string
    }> = []
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
      {
        async revert(sessionId, messageId) {
          calls.push({ method: 'revert', sessionId, messageId })
          return { id: sessionId, revert: { messageID: messageId } }
        },
        async unrevert(sessionId) {
          calls.push({ method: 'unrevert', sessionId })
          return { id: sessionId }
        },
      },
    )

    const revert = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'session/revert',
        params: { sessionId: 'session', messageId: 'msg_2' },
      }),
    })
    const unrevert = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'session/unrevert',
        params: { sessionId: 'session' },
      }),
    })

    expect(revert.status).toBe(200)
    expect(await revert.json()).toEqual({
      jsonrpc: '2.0',
      id: 41,
      result: { id: 'session', revert: { messageID: 'msg_2' } },
    })
    expect(unrevert.status).toBe(200)
    expect(await unrevert.json()).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { id: 'session' },
    })
    expect(calls).toEqual([
      { method: 'revert', sessionId: 'session', messageId: 'msg_2' },
      { method: 'unrevert', sessionId: 'session' },
    ])
  })

  test('rejects a missing revert messageId before calling the history service', async () => {
    let historyCalls = 0
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
      {
        async revert() {
          historyCalls += 1
          return {}
        },
        async unrevert() {
          return {}
        },
      },
    )

    const response = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 43,
        method: 'session/revert',
        params: { sessionId: 'session' },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 43,
      error: { code: -32602, message: 'messageId is required' },
    })
    expect(historyCalls).toBe(0)
  })

  test('maps a native OpenCode history failure to a JSON-RPC server error', async () => {
    const history = createOpenCodeSessionHistory(
      config(),
      () => 'http://127.0.0.1:4096',
      async () =>
        new Response(JSON.stringify({ error: 'message does not exist' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
      history,
    )

    const response = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 44,
        method: 'session/revert',
        params: { sessionId: 'session', messageId: 'missing' },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 44,
      error: {
        code: -32000,
        message: 'OpenCode session revert failed with HTTP 404',
        data: {
          status: 404,
          upstream: { error: 'message does not exist' },
        },
      },
    })
  })

  test('calls native OpenCode history with the canonical session and workspace', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const history = createOpenCodeSessionHistory(
      config(),
      () => 'http://127.0.0.1:4096',
      async (input, init) => {
        calls.push({ url: String(input), init })
        return Response.json({ ok: true })
      },
    )

    await history.revert('session/with space', 'msg_2')
    await history.unrevert('session/with space')

    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:4096/session/session%2Fwith%20space/revert?directory=%2Fworkspace',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageID: 'msg_2' }),
        },
      },
      {
        url: 'http://127.0.0.1:4096/session/session%2Fwith%20space/unrevert?directory=%2Fworkspace',
        init: { method: 'POST' },
      },
    ])
  })

  test('returns 202 for JSON-RPC notifications and responses', async () => {
    const app = createAcpRouter(
      config(),
      () => connection({ post: async () => {} }),
      () => 'session',
    )
    const response = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'session' },
      }),
    })
    expect(response.status).toBe(202)
  })

  test('rejects unsupported media types and malformed JSON-RPC', async () => {
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
    )
    const media = await request(app, '/session', {
      method: 'POST',
      body: '{}',
    })
    expect(media.status).toBe(415)

    const malformed = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session/load' }),
    })
    expect(malformed.status).toBe(400)
  })

  test('replays SSE from Last-Event-ID and sends an immediate header frame', async () => {
    let after = -1
    const app = createAcpRouter(
      config(),
      () =>
        connection({
          subscribe: (lastEventId, event, close = () => {}) => {
            after = lastEventId
            event({
              id: 8,
              envelope: {
                jsonrpc: '2.0',
                method: 'session/update',
                params: { value: 'replayed' },
              },
            })
            queueMicrotask(close)
            return () => {}
          },
        }),
      () => 'session',
    )

    const response = await request(app, '/session', {
      headers: {
        accept: 'text/event-stream',
        'last-event-id': '7',
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain(
      'id: 8\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"value":"replayed"}}',
    )
    expect(after).toBe(7)
  })

  test('starts a new SSE client at the current event tail', async () => {
    let after = -1
    const app = createAcpRouter(
      config(),
      () =>
        connection({
          lastEventId: 12,
          subscribe: (lastEventId, _event, close = () => {}) => {
            after = lastEventId
            queueMicrotask(close)
            return () => {}
          },
        }),
      () => 'session',
    )

    const response = await request(app, '/session', {
      headers: { accept: 'text/event-stream' },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      'id: 12\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}',
    )
    expect(after).toBe(12)
  })

  test('rejects an invalid Last-Event-ID', async () => {
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
    )
    const response = await request(app, '/session', {
      headers: {
        accept: 'text/event-stream',
        'last-event-id': '-1',
      },
    })
    expect(response.status).toBe(400)
  })

  test('rejects a route or payload for a different OpenCode session', async () => {
    const app = createAcpRouter(
      config(),
      () => connection(),
      () => 'session',
    )

    const wrongPath = await request(app, '/other', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/resume',
        params: { sessionId: 'other', cwd: '/workspace', mcpServers: [] },
      }),
    })
    expect(wrongPath.status).toBe(404)

    const wrongPayload = await request(app, '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'other', prompt: [] },
      }),
    })
    expect(wrongPayload.status).toBe(409)
  })
})
