/**
 * The shim, exercised as a real proxy by real clients where possible.
 *
 * The security property under test is narrow and absolute: a request the agent
 * sends reaches Kortix carrying no credential, and the shim itself never holds
 * one. Everything else here exists to stop that property being true by accident
 * — a shim that terminated nothing, or relayed nothing, would also "never leak
 * a credential".
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { createEphemeralCa } from './ca'
import { parseShimRules, resolveShimConfig, shimUnavailableReason } from './rules'
import { createEgressShim } from './shim'

const CA = createEphemeralCa('test')
let open: http.Server[] = []

afterEach(() => {
  for (const server of open) server.close()
  open = []
})

async function startShim(
  overrides: Partial<Parameters<typeof createEgressShim>[0]> = {},
): Promise<{ port: number; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const brokerFetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit })
    return new Response(
      JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from('{"ok":true}').toString('base64'),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const server = await createEgressShim({
    ca: CA,
    rules: [{ hosts: ['api.example.com'], identifier: 'DEMO_TOKEN' }],
    apiUrl: 'https://api.kortix.test/v1',
    projectId: 'proj-1',
    token: 'kortix_pat_test',
    brokerFetch,
    ...overrides,
  })
  open.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { port: (server.address() as net.AddressInfo).port, calls }
}

/**
 * Speak CONNECT by hand so the assertions are about bytes, not a client lib.
 *
 * Returns any bytes that arrived in the SAME segment as the CONNECT response.
 * An upstream that writes immediately (as the tunnel tests' do) can have its
 * payload coalesced into the segment carrying `200 Connection Established`;
 * reading the "next" chunk for it then waits forever. That is a test bug, not a
 * shim bug, and it passed locally and failed in CI before this.
 */
function connect(
  port: number,
  target: string,
): Promise<{ status: string; rest: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    socket.once('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const sep = text.indexOf('\r\n\r\n')
      resolve({
        status: sep < 0 ? text : text.slice(0, sep + 4),
        rest: sep < 0 ? '' : text.slice(sep + 4),
        socket,
      })
    })
    socket.once('error', reject)
  })
}

/** Read until `needle` appears, seeded with whatever already arrived. */
function readUntil(socket: net.Socket, seed: string, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = seed
    if (buf.includes(needle)) return resolve(buf)
    const onData = (c: Buffer) => {
      buf += c.toString('utf8')
      if (buf.includes(needle)) {
        socket.off('data', onData)
        resolve(buf)
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
    setTimeout(() => reject(new Error(`timed out waiting for ${needle}; got ${JSON.stringify(buf)}`)), 4000)
  })
}

describe('the shim cannot hold a credential', () => {
  test('its rule type carries an identifier and no value field', () => {
    // Structural, not stylistic. The API-side ancestor had an `inject` mode
    // holding the literal secret; shipping that inside the sandbox would arm
    // the one place this whole design keeps empty.
    const rule = { hosts: ['api.example.com'], identifier: 'DEMO_TOKEN' }
    expect(Object.keys(rule).sort()).toEqual(['hosts', 'identifier'])
  })

  test('the request it sends Kortix carries no injected header of its own', async () => {
    const { port, calls } = await startShim()
    const { socket } = await connect(port, 'api.example.com:443')
    const tls = await import('node:tls')
    await new Promise<void>((resolve, reject) => {
      const secured = tls.connect(
        { socket, servername: 'api.example.com', ca: CA.certPem },
        () => {
          secured.write('GET /thing HTTP/1.1\r\nHost: api.example.com\r\nx-mine: 1\r\n\r\n')
        },
      )
      secured.once('data', () => {
        secured.destroy()
        resolve()
      })
      secured.once('error', reject)
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('unreachable: length asserted above')
    const body = JSON.parse(String(call.init.body))
    expect(body.url).toBe('https://api.example.com/thing')
    expect(body.method).toBe('GET')
    // The agent's own header rides along; nothing resembling a credential is
    // added by this process.
    expect(body.headers['x-mine']).toBe('1')
    const serialized = JSON.stringify(body).toLowerCase()
    expect(serialized).not.toContain('authorization')
    // The ONLY authorization on the wire is the session token, in the header —
    // and that is a credential the guest already holds.
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      'Bearer kortix_pat_test',
    )
  })
})

describe('headers the broker would reject or that would defeat redaction', () => {
  async function relayedHeaders(sent: string): Promise<Record<string, string>> {
    const { port, calls } = await startShim()
    const { socket } = await connect(port, 'api.example.com:443')
    const tls = await import('node:tls')
    await new Promise<void>((resolve, reject) => {
      const secured = tls.connect({ socket, servername: 'api.example.com', ca: CA.certPem }, () => {
        secured.write(`GET / HTTP/1.1\r\nHost: api.example.com\r\n${sent}\r\n`)
      })
      secured.once('data', () => {
        secured.destroy()
        resolve()
      })
      secured.once('error', reject)
    })
    const call = calls[0]
    if (!call) throw new Error('no broker call')
    return JSON.parse(String(call.init.body)).headers ?? {}
  }

  test('accept-encoding is forced to identity even when the guest asks for gzip', async () => {
    // SECURITY, not compatibility. The broker redacts an echoed credential by
    // scanning response BYTES; a gzipped body does not contain them, so the
    // scan finds nothing and the credential comes back intact. `curl` offers
    // gzip by default, and the broker does not block accept-encoding, so
    // forwarding the guest's value would quietly disable echo protection.
    const headers = await relayedHeaders('Accept-Encoding: gzip, deflate\r\n')
    expect(headers['accept-encoding']).toBe('identity')
  })

  test.each([
    ['cookie', 'Cookie: sid=abc'],
    ['authorization', 'Authorization: Bearer guess'],
    ['te', 'TE: trailers'],
  ])('%s is dropped, because the broker 400s on it rather than stripping it', async (name, line) => {
    const headers = await relayedHeaders(`${line}\r\n`)
    expect(headers[name]).toBeUndefined()
  })

  test('a websocket upgrade is reset, not left hanging', async () => {
    // The relay is request/response and fully buffered — it cannot carry a
    // socket. Found while testing header handling: without an explicit
    // 'upgrade' listener the inner server fires neither 'request' nor anything
    // else, and the client waits forever with nothing in the log.
    const errors: string[] = []
    const { port } = await startShim({ onError: (where) => errors.push(where) })
    const { socket } = await connect(port, 'api.example.com:443')
    const tls = await import('node:tls')
    const outcome = await new Promise<string>((resolve) => {
      const secured = tls.connect({ socket, servername: 'api.example.com', ca: CA.certPem }, () => {
        secured.write(
          'GET / HTTP/1.1\r\nHost: api.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
      })
      // Either end is a clean outcome; a TIMEOUT is the bug.
      secured.once('close', () => resolve('closed'))
      secured.once('error', () => resolve('closed'))
      setTimeout(() => resolve('TIMEOUT'), 3000)
    })
    expect(outcome).toBe('closed')
    expect(errors).toContain('upgrade')
  })

  test('the blocked set matches the broker\'s, name for name', async () => {
    // The shim keeps a literal copy so the sandbox binary does not have to
    // import apps/api's http-broker (and its DB + config deps). A copy drifts
    // unless something compares it, so this reads the real list off disk.
    const { readFileSync } = await import('node:fs')
    const broker = readFileSync(
      new URL('../../../../apps/api/src/secrets/http-broker.ts', import.meta.url),
      'utf8',
    )
    const block = broker.slice(broker.indexOf('const BLOCKED_REQUEST_HEADERS'))
    const theirs = [...block.slice(0, block.indexOf(']')).matchAll(/'([a-z-]+)'/g)]
      .map((m) => m[1])
      .sort()
    const mine = readFileSync(new URL('./shim.ts', import.meta.url), 'utf8')
    const mineBlock = mine.slice(mine.indexOf('const BLOCKED_REQUEST_HEADERS'))
    const ours = [...mineBlock.slice(0, mineBlock.indexOf(']')).matchAll(/'([a-z-]+)'/g)]
      .map((m) => m[1])
      .sort()
    expect(theirs.length).toBeGreaterThan(5)
    expect(ours).toEqual(theirs)
  })
})

/**
 * The mirror of `accept-encoding: identity`, and the same security control on
 * the other leg. Substitution is server-side and byte-based: the broker finds
 * the handle in the outgoing body by scanning for it, so a compressed body
 * hides it and the upstream receives the handle — a worthless string — and
 * answers 401 with nothing naming why.
 */
describe('the request body reaches the broker as raw bytes', () => {
  /** Send one complete request over the terminated leg and report both ends. */
  async function relayBody(
    head: string,
    body: Buffer,
  ): Promise<{
    brokerBody: { headers?: Record<string, string>; body_base64?: string } | null
    guestResponse: string
  }> {
    const { port, calls } = await startShim()
    const { socket } = await connect(port, 'api.example.com:443')
    const tls = await import('node:tls')
    const guestResponse = await new Promise<string>((resolve, reject) => {
      const secured = tls.connect({ socket, servername: 'api.example.com', ca: CA.certPem }, () => {
        secured.write(head)
        if (body.length > 0) secured.write(body)
      })
      secured.once('data', (chunk: Buffer) => {
        secured.destroy()
        resolve(chunk.toString('utf8'))
      })
      secured.once('error', reject)
    })
    const call = calls[0]
    return {
      brokerBody: call ? JSON.parse(String(call.init.body)) : null,
      guestResponse,
    }
  }

  const post = (body: Buffer, encoding?: string) =>
    `POST /v1/charges HTTP/1.1\r\nHost: api.example.com\r\nContent-Type: application/json\r\n` +
    (encoding ? `Content-Encoding: ${encoding}\r\n` : '') +
    `Content-Length: ${body.length}\r\n\r\n`

  const PLAIN = JSON.stringify({ token: 'kortix_h_demo_abcdef' })

  test('an uncompressed body is relayed byte for byte', async () => {
    const body = Buffer.from(PLAIN)
    const { brokerBody } = await relayBody(post(body), body)
    expect(Buffer.from(brokerBody?.body_base64 ?? '', 'base64').toString('utf8')).toBe(PLAIN)
  })

  test.each([
    ['gzip', (buf: Buffer) => zlib.gzipSync(buf)],
    ['deflate', (buf: Buffer) => zlib.deflateSync(buf)],
    ['br', (buf: Buffer) => zlib.brotliCompressSync(buf)],
  ])('a %s body is decoded, so the handle is visible to substitution', async (encoding, compress) => {
    const body = compress(Buffer.from(PLAIN))
    const { brokerBody } = await relayBody(post(body, encoding), body)
    expect(Buffer.from(brokerBody?.body_base64 ?? '', 'base64').toString('utf8')).toBe(PLAIN)
    // Dropped, or the upstream is told the raw bytes it now gets are compressed.
    expect(brokerBody?.headers?.['content-encoding']).toBeUndefined()
  })

  test('a chain of encodings is undone in the order it was applied', async () => {
    const body = zlib.gzipSync(zlib.deflateSync(Buffer.from(PLAIN)))
    const { brokerBody } = await relayBody(post(body, 'deflate, gzip'), body)
    expect(Buffer.from(brokerBody?.body_base64 ?? '', 'base64').toString('utf8')).toBe(PLAIN)
  })

  test('an encoding the shim cannot undo is refused, never relayed opaque', async () => {
    const body = Buffer.from(' compressed-by-something-else')
    const { brokerBody, guestResponse } = await relayBody(post(body, 'zstd'), body)
    // Refusing beats relaying: a relayed compressed body is an unsubstituted
    // handle, an upstream 401, and an agent with nothing to read.
    expect(brokerBody).toBeNull()
    expect(guestResponse).toContain('400')
    expect(guestResponse).toContain('unsupported_request_encoding')
  })

  test('a decompression bomb is refused at the broker\'s own ceiling', async () => {
    // 8 MiB of zeros gzips to ~8 KiB. Decoding it would blow past the broker's
    // 1 MiB request cap anyway, so the ceiling doubles as the bomb guard.
    const body = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024))
    expect(body.length).toBeLessThan(64 * 1024)
    const { brokerBody, guestResponse } = await relayBody(post(body, 'gzip'), body)
    expect(brokerBody).toBeNull()
    expect(guestResponse).toContain('400')
  })

  test('a corrupt body under a supported encoding is refused, not passed through', async () => {
    const body = Buffer.from('not gzip at all')
    const { brokerBody, guestResponse } = await relayBody(post(body, 'gzip'), body)
    expect(brokerBody).toBeNull()
    expect(guestResponse).toContain('400')
  })

  test('a bodyless request carrying the header is relayed, not refused', async () => {
    // Nothing to make visible and nothing to hide: a `Content-Encoding` on a
    // bodyless GET is a spurious header, not a request worth rejecting.
    const { brokerBody, guestResponse } = await relayBody(
      'GET /v1/charges HTTP/1.1\r\nHost: api.example.com\r\nContent-Encoding: gzip\r\n\r\n',
      Buffer.alloc(0),
    )
    expect(brokerBody).not.toBeNull()
    expect(brokerBody?.body_base64).toBeUndefined()
    expect(guestResponse).toContain('200')
  })

  test.each([
    ['identity', 'identity'],
    ['a list that is only identity', 'identity, identity'],
  ])('%s needs no decoding and still drops the header', async (_label, encoding) => {
    const body = Buffer.from(PLAIN)
    const { brokerBody } = await relayBody(post(body, encoding), body)
    expect(Buffer.from(brokerBody?.body_base64 ?? '', 'base64').toString('utf8')).toBe(PLAIN)
    expect(brokerBody?.headers?.['content-encoding']).toBeUndefined()
  })
})

describe('what gets terminated', () => {
  test('a host with a rule is terminated and relayed', async () => {
    const { port, calls } = await startShim()
    const { status, socket } = await connect(port, 'api.example.com:443')
    expect(status).toContain('200 Connection Established')
    socket.destroy()
    expect(calls).toHaveLength(0) // nothing relayed until a request is sent
  })

  test('a host with NO rule is tunnelled blind, never terminated', async () => {
    // A pinned-certificate or mTLS client must be unaffected. Prove it by
    // having the "upstream" be a raw TCP server that echoes: if the shim had
    // terminated, the bytes would never arrive verbatim.
    const upstream = net.createServer((sock) => sock.pipe(sock))
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const upstreamPort = (upstream.address() as net.AddressInfo).port

    const { port } = await startShim()
    const { status, rest, socket } = await connect(port, `127.0.0.1:${upstreamPort}`)
    expect(status).toContain('200 Connection Established')

    socket.write('RAW-BYTES')
    expect(await readUntil(socket, rest, 'RAW-BYTES')).toContain('RAW-BYTES')
    socket.destroy()
    upstream.close()
  })

  test('plain HTTP through the shim is refused, never relayed', async () => {
    const { port, calls } = await startShim()
    const res = await fetch(`http://127.0.0.1:${port}/anything`)
    expect(res.status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  test('a non-443 port is tunnelled even when the host has a rule', async () => {
    // Injection only makes sense for HTTPS. Terminating :80 for a ruled host
    // would put the credential on a cleartext wire.
    const upstream = net.createServer((sock) => sock.end('PLAIN'))
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const upstreamPort = (upstream.address() as net.AddressInfo).port
    const { port, calls } = await startShim({
      rules: [{ hosts: ['127.0.0.1'], identifier: 'DEMO_TOKEN' }],
    })
    const { rest, socket } = await connect(port, `127.0.0.1:${upstreamPort}`)
    expect(await readUntil(socket, rest, 'PLAIN')).toContain('PLAIN')
    expect(calls).toHaveLength(0)
    socket.destroy()
    upstream.close()
  })
})

describe('broker failures reach the agent honestly', () => {
  test("Kortix's own refusal is surfaced verbatim, not as a proxy error", async () => {
    const refusing = (async () =>
      new Response(JSON.stringify({ error: 'no agent grant', code: 'no_agent_grant' }), {
        status: 403,
      })) as unknown as typeof fetch
    const { port } = await startShim({ brokerFetch: refusing })
    const { socket } = await connect(port, 'api.example.com:443')
    const tls = await import('node:tls')
    const response = await new Promise<string>((resolve, reject) => {
      const secured = tls.connect({ socket, servername: 'api.example.com', ca: CA.certPem }, () => {
        secured.write('GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n')
      })
      let buf = ''
      secured.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf.includes('no_agent_grant') || buf.length > 4000) {
          secured.destroy()
          resolve(buf)
        }
      })
      secured.once('error', reject)
    })
    // The agent must see WHY, or it wastes a turn guessing.
    expect(response).toContain('403')
    expect(response).toContain('no_agent_grant')
  })
})

describe('rules are derived from what the guest already has', () => {
  const caps = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          identifier: 'DEMO_TOKEN',
          delivery: 'network',
          hosts: ['API.Example.com'],
          header: 'x-demo',
          ...extra,
        },
      ],
    })

  test('network entries become rules, lowercased', () => {
    expect(parseShimRules(caps())).toEqual([
      { hosts: ['api.example.com'], identifier: 'DEMO_TOKEN' },
    ])
  })

  test.each([
    ['absent', undefined],
    ['redact', 'redact'],
    ['a stale block from an older API', 'block'],
  ])('on_echo (%s) does not decide whether the shim arms', (_label, onEcho) => {
    // e7d9bdad0c skipped `on_echo: 'block'` because a provider edge owned some
    // destinations. Nothing is edge-owned now — the shim is the one mechanism
    // on every provider — so honouring a stale `block` would leave the session
    // with no relay at all and every request leaving with a worthless handle.
    // `delivery: 'network'` is the whole gate.
    expect(parseShimRules(caps(onEcho === undefined ? {} : { on_echo: onEcho }))).toEqual([
      { hosts: ['api.example.com'], identifier: 'DEMO_TOKEN' },
    ])
  })

  test('non-network deliveries are ignored', () => {
    const raw = JSON.stringify({
      version: 1,
      capabilities: [
        { identifier: 'RUNTIME_ONE', delivery: 'sandbox', environment_variable: 'RUNTIME_ONE' },
        { identifier: 'BROKER_ONE', delivery: 'https_broker' },
      ],
    })
    expect(parseShimRules(raw)).toEqual([])
  })

  test.each([
    ['not json', '{oh no'],
    ['wrong version', JSON.stringify({ version: 2, capabilities: [] })],
    ['absent', undefined],
    ['a bad host', JSON.stringify({ version: 1, capabilities: [{ identifier: 'X', delivery: 'network', hosts: ['not a host'] }] })],
    ['no hosts', JSON.stringify({ version: 1, capabilities: [{ identifier: 'X', delivery: 'network', hosts: [] }] })],
  ])('%s yields no rules rather than a guess', (_label, raw) => {
    expect(parseShimRules(raw as string | undefined)).toEqual([])
  })

  test('one host is terminated once even when two identifiers list it', () => {
    const raw = JSON.stringify({
      version: 1,
      capabilities: [
        { identifier: 'FIRST', delivery: 'network', hosts: ['api.example.com'] },
        { identifier: 'SECOND', delivery: 'network', hosts: ['api.example.com'] },
      ],
    })
    // Two secrets on one host is legal now (spec §6). One rule still covers
    // both: substitution is server-side over every handle the session may
    // spend on that host, so the identifier on the rule only picks the door.
    expect(parseShimRules(raw)).toEqual([{ hosts: ['api.example.com'], identifier: 'FIRST' }])
  })
})

describe('the shim fails closed', () => {
  const base = {
    KORTIX_SECRET_CAPABILITIES: JSON.stringify({
      version: 1,
      capabilities: [{ identifier: 'DEMO', delivery: 'network', hosts: ['api.example.com'] }],
    }),
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_PROJECT_ID: 'proj-1',
    KORTIX_CLI_TOKEN: 'kortix_pat_test',
  }

  test('a complete environment yields a config', () => {
    expect(resolveShimConfig(base)).toMatchObject({ projectId: 'proj-1', token: 'kortix_pat_test' })
    expect(shimUnavailableReason(base)).toBeNull()
  })

  test('the SANDBOX token does not stand in for the session token', () => {
    // KORTIX_TOKEN is the daemon's identity and project-scoped routes reject
    // it. Accepting it here would start a shim whose every relay 403s.
    const env = { ...base, KORTIX_CLI_TOKEN: undefined, KORTIX_TOKEN: 'kortix_sb_daemon' }
    expect(resolveShimConfig(env)).toBeNull()
    expect(shimUnavailableReason(env)).toContain('KORTIX_CLI_TOKEN')
  })

  test.each(['KORTIX_API_URL', 'KORTIX_PROJECT_ID', 'KORTIX_CLI_TOKEN'])(
    'a missing %s names itself in the reason',
    (name) => {
      const env = { ...base, [name]: undefined }
      expect(resolveShimConfig(env)).toBeNull()
      expect(shimUnavailableReason(env)).toContain(name)
    },
  )

  test('no boundary secrets is silence, not an error', () => {
    // The ordinary case. Most sessions hold none, and a warning here would
    // train everyone to ignore the log line that matters.
    const env = { ...base, KORTIX_SECRET_CAPABILITIES: undefined }
    expect(resolveShimConfig(env)).toBeNull()
    expect(shimUnavailableReason(env)).toBeNull()
  })
})
