import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { connect } from 'node:net'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import { startProxy } from '../proxy'
import { egressShimPort } from '../egress-shim'
import WebSocket from 'ws'

const TOKEN = 'sandbox-test-token'

function ticket(port: number, expiresAt = Math.floor(Date.now() / 1000) + 60): string {
  const payload = `localhost-preview:${port}.${expiresAt}`
  const signature = createHmac('sha256', TOKEN).update(payload).digest('base64url')
  return `${port}.${expiresAt}.${signature}`
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3000,
    workspace: '/tmp/preview-bridge-test',
    projectTarget: '/tmp/preview-bridge-test',
    defaultBranch: 'main',
    branchFetchAttempts: 1,
    branchFetchDelaySec: 0,
    defaultOpencodeConfigDir: '/tmp/opencode',
    autoClone: false,
    projectId: 'project-test',
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    sandboxToken: TOKEN,
    ...overrides,
  } as Config
}

function fakeOpencode(): Opencode {
  return {
    getState: () => 'ok',
    getInternalUrl: () => 'http://127.0.0.1:4096',
    getActivePort: () => 4096,
    getPid: () => undefined,
  } as unknown as Opencode
}

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('localhost preview bridge', () => {
  test('a signed target dispatches the original request to localhost', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: async (request) => Response.json({
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        body: Array.from(new Uint8Array(await request.arrayBuffer())),
        host: request.headers.get('host'),
      }),
    })
    servers.push(upstream)
    const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())

    const response = await app.request('http://daemon/__kortix_preview/kortix/health?framework=next', {
      method: 'POST',
      headers: { 'X-Kortix-Preview-Target': ticket(upstream.port!) },
      body: new Uint8Array([0, 1, 2, 255]),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/kortix/health?framework=next',
      body: [0, 1, 2, 255],
        host: `localhost:${upstream.port}`,
    })
  })

  test('normalizes browser headers and strips credentials and connection fields', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: (request) => Response.json(Object.fromEntries(request.headers.entries())),
    })
    servers.push(upstream)
    const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())
    const response = await app.request('http://daemon/__kortix_preview/assets/main.js', {
      headers: {
        'X-Kortix-Preview-Target': ticket(upstream.port!),
        Authorization: 'Bearer secret',
        'Proxy-Authorization': 'Basic secret',
        'X-Kortix-User-Context': 'secret-context',
        'X-Daytona-Preview-Token': 'daytona-secret',
        'X-Daytona-Skip-Preview-Warning': '1',
        'X-Daytona-Disable-Cors': '1',
        'E2B-Traffic-Access-Token': 'e2b-secret',
        Forwarded: 'for=external',
        'X-Forwarded-For': 'external',
        'X-Forwarded-Port': '443',
        'X-Forwarded-Prefix': '/public-preview',
        Connection: 'keep-alive, x-private-hop',
        'X-Private-Hop': 'secret-hop',
        Origin: 'https://preview.example',
        Referer: 'https://preview.example/dashboard?q=one',
      },
    })
    const headers = await response.json() as Record<string, string>

    expect(headers.host).toBe(`localhost:${upstream.port}`)
    expect(headers.origin).toBe(`http://localhost:${upstream.port}`)
    expect(headers.referer).toBe(`http://localhost:${upstream.port}/dashboard?q=one`)
    expect(headers['x-forwarded-host']).toBe(`localhost:${upstream.port}`)
    expect(headers['x-forwarded-proto']).toBe('http')
    expect(headers['x-forwarded-prefix']).toBe('/public-preview')
    for (const name of [
      'authorization', 'proxy-authorization', 'x-kortix-user-context',
      'x-kortix-preview-target', 'x-daytona-preview-token',
      'x-daytona-skip-preview-warning', 'x-daytona-disable-cors',
      'e2b-traffic-access-token', 'forwarded', 'x-forwarded-for',
      'x-forwarded-port', 'x-private-hop',
    ]) expect(headers[name]).toBeUndefined()
  })

  test('preserves cookies and rewrites localhost self redirects to root-relative paths', async () => {
    let upstreamPort = 0
    const upstream = Bun.serve({
      port: 0,
      fetch: (request) => new Response(null, { status: 302, headers: {
        location: `http://localhost:${upstreamPort}/login?next=%2Fprivate`,
        'set-cookie': `sid=${request.headers.get('cookie')}; Path=/; HttpOnly`,
      } }),
    })
    upstreamPort = upstream.port!
    servers.push(upstream)
    const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())
    const response = await app.request('http://daemon/__kortix_preview/private', {
      headers: {
        'X-Kortix-Preview-Target': ticket(upstream.port!),
        Cookie: 'abc123',
      },
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?next=%2Fprivate')
    expect(response.headers.get('set-cookie')).toBe('sid=abc123; Path=/; HttpOnly')
  })

  test('resolves nested relative and query-only redirects against the upstream request URL', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        const location = url.pathname === '/account/private' ? 'login?next=one' : '?step=2'
        return new Response(null, { status: 302, headers: { location } })
      },
    })
    servers.push(upstream)
    const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())

    const nested = await app.request('http://daemon/__kortix_preview/account/private', {
      headers: { 'X-Kortix-Preview-Target': ticket(upstream.port!) },
    })
    expect(nested.headers.get('location')).toBe('/account/login?next=one')

    const queryOnly = await app.request('http://daemon/__kortix_preview/account/login?step=1', {
      headers: { 'X-Kortix-Preview-Target': ticket(upstream.port!) },
    })
    expect(queryOnly.headers.get('location')).toBe('/account/login?step=2')
  })

  test('fails closed for missing, forged, expired, misplaced, and blocked tickets', async () => {
    const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())
    const now = Math.floor(Date.now() / 1000)
    const cases: Array<[string, RequestInit, number]> = [
      ['/__kortix_preview/', {}, 401],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': `${ticket(3001).slice(0, -1)}x` } }, 401],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(3001, now - 1) } }, 401],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(3001, now) } }, 401],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(3001, now + 61) } }, 401],
      ['/outside-prefix', { headers: { 'X-Kortix-Preview-Target': ticket(3001) } }, 401],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(8000) } }, 403],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(4096) } }, 403],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(4097) } }, 403],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(egressShimPort()) } }, 403],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(4319) } }, 403],
      ['/__kortix_preview/', { headers: { 'X-Kortix-Preview-Target': ticket(4320) } }, 403],
    ]
    for (const [path, init, status] of cases) {
      const response = await app.request(`http://daemon${path}`, init)
      expect(response.status).toBe(status)
      expect(response.headers.get('x-kortix-preview-bridge')).toBeNull()
    }
  })

  test('fails closed when an empty target header is present outside the prefix over HTTP and WebSocket', async () => {
    const daemon = startProxy(config({ servicePort: 0 }), fakeOpencode(), Date.now())
    const httpResponse = await fetch(`http://127.0.0.1:${daemon.port}/kortix/health`, {
      headers: { 'X-Kortix-Preview-Target': '' },
    })
    expect(httpResponse.status).toBe(401)

    const wsStatus = await new Promise<number>((resolve, reject) => {
      const socket = connect(daemon.port, '127.0.0.1')
      let response = ''
      socket.once('connect', () => socket.write([
        'GET /kortix/pty/connect HTTP/1.1',
        `Host: 127.0.0.1:${daemon.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==',
        'X-Kortix-Preview-Target:',
        '', '',
      ].join('\r\n')))
      socket.on('data', (chunk) => {
        response += chunk.toString()
        const match = /^HTTP\/1\.1 (\d{3})/.exec(response)
        if (match) {
          socket.destroy()
          resolve(Number(match[1]))
        }
      })
      socket.once('error', reject)
    })
    expect(wsStatus).toBe(401)
    await daemon.stop()
  })

  test('blocks configured credential-injecting proxy ports over HTTP and WebSocket', async () => {
    const oldLlmPort = process.env.KORTIX_LLM_PROXY_PORT
    const oldConnectorPort = process.env.KORTIX_CONNECTORS_PROXY_PORT
    process.env.KORTIX_LLM_PROXY_PORT = '5319'
    process.env.KORTIX_CONNECTORS_PROXY_PORT = '5320'
    try {
      const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())
      for (const port of [5319, 5320]) {
        const response = await app.request('http://daemon/__kortix_preview/', {
          headers: { 'X-Kortix-Preview-Target': ticket(port) },
        })
        expect(response.status).toBe(403)
      }

      const daemon = startProxy(config({ servicePort: 0 }), fakeOpencode(), Date.now())
      for (const port of [4319, 4320, 5319, 5320]) {
        const status = await new Promise<number>((resolve, reject) => {
          const socket = connect(daemon.port, '127.0.0.1')
          let response = ''
          socket.once('connect', () => socket.write([
            'GET /__kortix_preview/socket HTTP/1.1',
            `Host: 127.0.0.1:${daemon.port}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==',
            `X-Kortix-Preview-Target: ${ticket(port)}`,
            '', '',
          ].join('\r\n')))
          socket.on('data', (chunk) => {
            response += chunk.toString()
            const match = /^HTTP\/1\.1 (\d{3})/.exec(response)
            if (match) {
              socket.destroy()
              resolve(Number(match[1]))
            }
          })
          socket.once('error', reject)
        })
        expect(status).toBe(403)
      }
      await daemon.stop()
    } finally {
      if (oldLlmPort === undefined) delete process.env.KORTIX_LLM_PROXY_PORT
      else process.env.KORTIX_LLM_PROXY_PORT = oldLlmPort
      if (oldConnectorPort === undefined) delete process.env.KORTIX_CONNECTORS_PROXY_PORT
      else process.env.KORTIX_CONNECTORS_PROXY_PORT = oldConnectorPort
    }
  })

  test('marks an application error response without changing it', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response('app says no', { status: 401 }),
    })
    servers.push(upstream)
    const app = buildOpencodeApp(config(), fakeOpencode(), Date.now())

    const response = await app.request('http://daemon/__kortix_preview/private', {
      headers: { 'X-Kortix-Preview-Target': ticket(upstream.port!) },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('x-kortix-preview-bridge')).toBe('1')
    expect(await response.text()).toBe('app says no')
  })

  test('bridges a real WebSocket with protocol, early, text, and binary messages', async () => {
    let resolveUpstreamClosed!: () => void
    const upstreamClosed = new Promise<void>((resolve) => { resolveUpstreamClosed = resolve })
    const upstream = Bun.serve<{ connected: true }>({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { connected: true }, headers: {
          'Sec-WebSocket-Protocol': 'hmr-v2',
        } })) return undefined
        return new Response('upgrade required', { status: 426 })
      },
      websocket: {
        open(ws) { ws.send('early') },
        message(ws, message) { ws.send(message) },
        close() { resolveUpstreamClosed() },
      },
    })
    servers.push(upstream)
    const daemon = startProxy(config({ servicePort: 0 }), fakeOpencode(), Date.now())
    const messages: Array<string | Buffer> = []
    const client = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/__kortix_preview/socket?hot=1`,
      ['hmr-v1', 'hmr-v2'],
      { headers: { 'X-Kortix-Preview-Target': ticket(upstream.port!) } },
    )
    client.on('message', (data, isBinary) => messages.push(
      isBinary
        ? (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer))
        : data.toString(),
    ))

    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    expect(client.protocol).toBe('hmr-v2')
    client.send('hello')
    client.send(Buffer.from([0, 255, 7]))
    await Bun.sleep(50)
    expect(messages).toContain('early')
    expect(messages).toContain('hello')
    expect(messages.some((value) => Buffer.isBuffer(value) && value.equals(Buffer.from([0, 255, 7])))).toBe(true)

    client.close()
    await upstreamClosed
    await daemon.stop()
  })

  test('reflects no subprotocol and propagates an upstream disconnect', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return undefined
        return new Response('upgrade required', { status: 426 })
      },
      websocket: {
        open(ws) { ws.close(4001, 'app restart') },
        message() {},
      },
    })
    servers.push(upstream)
    const daemon = startProxy(config({ servicePort: 0 }), fakeOpencode(), Date.now())
    const client = new WebSocket(`ws://127.0.0.1:${daemon.port}/__kortix_preview/socket`, {
      headers: { 'X-Kortix-Preview-Target': ticket(upstream.port!) },
    })

    const closed = await new Promise<{ code: number; reason: string; protocol: string }>((resolve, reject) => {
      client.once('close', (code, reason) => resolve({ code, reason: reason.toString(), protocol: client.protocol }))
      client.once('error', reject)
    })
    expect(closed).toEqual({ code: 4001, reason: 'app restart', protocol: '' })
    await daemon.stop()
  })
})
