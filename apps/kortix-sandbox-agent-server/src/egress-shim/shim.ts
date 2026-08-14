/**
 * The in-guest egress shim — network-boundary secrets on a provider with no
 * credential edge of its own.
 *
 * Platinum injects at its own edge. Daytona has none, and cannot be pointed at
 * one (`outboundProxyUrl` is accepted and ignored — measured, see
 * docs/NETWORK_BOUNDARY_ON_DAYTONA.md §7). The way out is to notice the proxy
 * does two separable jobs:
 *
 *   1. terminate the guest's TLS  — can only happen INSIDE the guest
 *   2. hold the credential        — must NOT happen inside the guest
 *
 * Nothing requires those to be the same process, so they are split (§7.4):
 *
 *   agent ──HTTPS──▶ this shim ──HTTPS──▶ Kortix broker route ──▶ upstream
 *                    (ephemeral CA,        (holds the credential,
 *                     holds NOTHING)        injects, redacts the echo)
 *
 * ## This file cannot hold a secret, by construction
 *
 * There is exactly one rule shape here and it carries an `identifier`, never a
 * value. The API-side ancestor of this file also had an `inject` mode that held
 * the credential literally; that mode is deliberately absent. Shipping it in a
 * binary that runs inside the sandbox would be a loaded gun in the one place
 * the whole design exists to keep empty — an agent that reads this process,
 * patches it, or dumps its memory must learn nothing.
 *
 * ## Selective termination is not an optimisation
 *
 * Blanket MITM would break every pinned-certificate client and mTLS handshake
 * in the sandbox. Only hosts carrying a rule are terminated; everything else is
 * tunnelled blind and the shim never sees a byte of it.
 */
import { Buffer } from 'node:buffer'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'

import { LeafIssuer, type EphemeralCa } from './ca'
import type { ShimBrokerRule } from './rules'

export interface EgressShimOptions {
  readonly ca: EphemeralCa
  readonly rules: readonly ShimBrokerRule[]
  /** Kortix API base, e.g. `https://dev-api.kortix.com/v1`. */
  readonly apiUrl: string
  readonly projectId: string
  /** The session credential — already in the guest; grants no new authority. */
  readonly token: string
  /**
   * Test seam: replace the broker call. Production leaves this unset.
   *
   * The only seam here. An `upstreamOptions` hook was carried over from the
   * API-side ancestor and deleted: the blind-tunnel path uses `net.connect`,
   * never `https.request`, so nothing read it. A seam a test can set but the
   * code never consults is worse than none — it reads like coverage.
   */
  readonly brokerFetch?: typeof fetch
  readonly onError?: (where: string, err: Error) => void
}

const BROKER_TIMEOUT_MS = 30_000

/**
 * Headers the broker REJECTS with a 400 rather than stripping
 * (apps/api/src/secrets/http-broker.ts BLOCKED_REQUEST_HEADERS).
 *
 * Mirrored here so the shim drops them before relaying. Forwarding them turns
 * an ordinary request into `400 request header is managed by Kortix: cookie` —
 * and a cookie-bearing client, or any `curl -H 'Authorization: ...'`, is an
 * entirely reasonable thing for an agent to run.
 *
 * Kept as a literal copy rather than an import: this binary must not drag
 * apps/api's http-broker (and its DB and config dependencies) into the sandbox.
 * The `blocked-headers` test asserts the two lists still agree.
 */
const BLOCKED_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function ruleFor(rules: readonly ShimBrokerRule[], host: string): ShimBrokerRule | null {
  const needle = host.toLowerCase()
  return rules.find((rule) => rule.hosts.some((h) => h === needle)) ?? null
}

function parseTarget(target: string): { host: string; port: number } | null {
  // CONNECT targets are `host:port`; an IPv6 literal is bracketed.
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target.trim())
  const rawHost = match?.[1]
  const rawPort = match?.[2]
  if (!rawHost || !rawPort) return null
  const host = rawHost.replace(/^\[|\]$/g, '')
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

/**
 * Hand the guest's request to Kortix, which holds the credential.
 *
 * Deliberately the SAME broker route that `kortix secrets call` and the
 * `secret_call` MCP tool already use, so the shim inherits a path that is
 * shipped, tested and verified live rather than opening a second way to spend a
 * secret. The host/method policy, the injection, and the echo redaction all
 * happen there, server-side.
 */
async function relayToBroker(
  options: EgressShimOptions,
  rule: ShimBrokerRule,
  host: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
): Promise<void> {
  // Forward only the request's own headers. Nothing secret is added here —
  // that is the entire point of this mode.
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue
    if (typeof value === 'string') forwarded[lower] = value
  }
  // Force identity, ALWAYS, overriding whatever the guest asked for.
  //
  // This is a security control, not a compatibility tweak. The broker redacts
  // an echoed credential by scanning the response bytes; a gzipped body does
  // not contain those bytes, so the scan finds nothing and the credential is
  // returned to the guest intact. The out-of-guest proxy forced identity for
  // exactly this reason and the broker does NOT do it for us — `accept-encoding`
  // is absent from its blocked list, so a plain `curl` (which offers gzip by
  // default) would defeat echo protection.
  //
  // It is also the only correct answer for the guest: `content-encoding` is not
  // in the broker's response-header whitelist, so compressed bytes would arrive
  // with nothing saying they were compressed.
  forwarded['accept-encoding'] = 'identity'

  const call = options.brokerFetch ?? fetch
  const url =
    `${options.apiUrl.replace(/\/$/, '')}/projects/${options.projectId}` +
    `/secrets/${encodeURIComponent(rule.identifier)}/broker`
  const response = await call(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `https://${host}${req.url ?? '/'}`,
      method: (req.method ?? 'GET').toUpperCase(),
      ...(Object.keys(forwarded).length > 0 ? { headers: forwarded } : {}),
      ...(body.length > 0 ? { body_base64: body.toString('base64') } : {}),
    }),
    signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
  })

  if (!response.ok) {
    // Surface Kortix's own refusal verbatim: a denied grant or an out-of-policy
    // host must reach the agent as that, not as a generic proxy error it will
    // waste a turn guessing about.
    const detail = await response.text().catch(() => '')
    res.writeHead(response.status, { 'content-type': 'application/json' })
    res.end(detail || JSON.stringify({ error: 'broker refused the request' }))
    return
  }

  const result = (await response.json()) as {
    status?: number
    headers?: Record<string, string>
    body_base64?: string
  }
  const out = Buffer.from(result.body_base64 ?? '', 'base64')
  const headers: Record<string, string> = { ...(result.headers ?? {}) }
  // The body was fully buffered, so the upstream's framing no longer describes
  // it. State the real length rather than deleting both headers and letting the
  // server pick — under Bun that leaves the response held instead of flushed,
  // which reads as a hang with no error anywhere (measured).
  delete headers['transfer-encoding']
  headers['content-length'] = String(out.length)
  if (/close/i.test(String(req.headers.connection ?? ''))) headers.connection = 'close'
  res.writeHead(result.status ?? 502, headers)
  res.end(out)
}

/**
 * Async because the shim owns loopback TLS listeners that must be bound before
 * the first CONNECT can be served.
 */
export async function createEgressShim(options: EgressShimOptions): Promise<http.Server> {
  const issuer = new LeafIssuer(options.ca)
  const fail = options.onError ?? (() => {})

  /**
   * Serves the guest's decrypted requests.
   *
   * A REAL listener on loopback that the guest's tunnel is piped into, rather
   * than an `http.Server` handed a socket via `emit('connection')`. That trick
   * is Node-only — measured: under Bun the request event never fires and the
   * connection just hangs, while the identical script works under Node. The
   * daemon runs on Bun, so the socket has to reach a genuine listening port.
   *
   * The per-connection rule is keyed by the loopback source port, which is
   * unique per connection and is what the inner server sees as
   * `req.socket.remotePort`.
   */
  const bindings = new Map<number, { rule: ShimBrokerRule; host: string }>()
  const onTerminatedRequest: http.RequestListener = (req, res) => {
    const binding = bindings.get(req.socket.remotePort ?? -1)
    if (!binding) {
      res.writeHead(500).end('kortix egress shim: no rule bound to connection')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void relayToBroker(
        options,
        binding.rule,
        binding.host,
        req,
        res,
        Buffer.concat(chunks),
      ).catch((err: Error) => {
        fail('broker', err)
        if (!res.headersSent) res.writeHead(502)
        res.end('kortix egress shim: broker relay failed')
      })
    })
  }

  /**
   * One loopback TLS listener per terminated host, each holding that host's
   * leaf as a STATIC cert.
   *
   * The obvious design is a single listener with `SNICallback` picking the leaf
   * per connection. Bun never invokes SNICallback — measured: the handshake
   * completes against a default certificate and the callback does not fire,
   * while the same script works under Node — so the certificate has to be fixed
   * at listen() time. Listeners are bounded by the number of distinct hosts
   * carrying a rule, which is small, and are created once.
   */
  const listeners = new Map<string, Promise<number>>()
  const innerServers: https.Server[] = []
  function listenerFor(host: string): Promise<number> {
    const existing = listeners.get(host)
    if (existing) return existing
    const started = (async () => {
      const leaf = issuer.issue(host)
      const inner = https.createServer({ cert: leaf.certPem, key: leaf.keyPem })
      inner.on('request', onTerminatedRequest)
      inner.on('clientError', (err) => fail('terminated-client', err))
      // A protocol upgrade (websocket) on a terminated host fires 'upgrade',
      // never 'request', so nothing above would run and the client would hang
      // forever with no log line. The relay is request/response and fully
      // buffered — it cannot carry a socket — so the connection is reset.
      //
      // It is RESET rather than answered 501, and that is a Bun limitation, not
      // a preference. Measured (bun 1.3.14 vs node v22.22.0): Bun fires the
      // event but a write from this handler never reaches the client, which
      // then times out; Node delivers the same bytes fine. This is the THIRD
      // divergence in this file's neighbourhood, after `emit('connection')`
      // being a no-op and SNICallback never firing.
      inner.on('upgrade', (_req, socket) => {
        fail('upgrade', new Error('protocol upgrade is not supported through the egress shim'))
        socket.destroy()
      })
      await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve))
      innerServers.push(inner)
      return (inner.address() as net.AddressInfo).port
    })()
    listeners.set(host, started)
    return started
  }

  const server = http.createServer((_req, res) => {
    // Plain HTTP through the shim is refused outright. Relaying a cleartext
    // request would have Kortix add a credential to a connection that then
    // continues in the clear, which is strictly worse than not having the
    // feature.
    res.writeHead(405).end('kortix egress shim: HTTPS CONNECT only')
  })

  server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = parseTarget(req.url ?? '')
    if (!target) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    socket.on('error', (err) => fail('client', err as Error))

    const rule = target.port === 443 ? ruleFor(options.rules, target.host) : null
    if (!rule) {
      // No rule: blind tunnel. The shim carries the bytes and never looks at
      // them, so a pinned or mTLS client is unaffected.
      const upstream = net.connect(target.port, target.host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', (err) => {
        fail('tunnel', err)
        socket.destroy()
      })
      return
    }

    // Rule: hand the tunnel to our own TLS listener for this host, which
    // terminates it, parses the request, and relays it to Kortix.
    void listenerFor(target.host)
      .then((terminatedPort) => {
        const inner = net.connect(terminatedPort, '127.0.0.1', () => {
          // Bind BEFORE any byte flows, so the request handler can never look
          // up a port that has not been registered yet.
          bindings.set(inner.localPort ?? -1, { rule, host: target.host })
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head?.length) inner.write(head)
          inner.pipe(socket)
          socket.pipe(inner)
        })
        const release = () => {
          if (inner.localPort) bindings.delete(inner.localPort)
        }
        inner.on('close', release)
        inner.on('error', (err) => {
          fail('terminate', err)
          release()
          socket.destroy()
        })
      })
      .catch((err) => {
        fail('listener', err as Error)
        socket.destroy()
      })
  })

  // Pre-issue every rule host's leaf, off the request path.
  //
  // RSA-2048 in pure JS costs ~90-170ms per certificate (measured under Bun
  // 1.3.14). Paid lazily inside the first CONNECT, that is a visible stall on
  // the agent's first call to each host. The hosts are known here and the
  // issuer caches, so doing it now moves the cost to boot.
  //
  // It has to happen HERE, against this issuer. An earlier version warmed a
  // second LeafIssuer built from the same CA — which issues perfectly good
  // certificates into a cache nothing reads, and warms nothing at all.
  for (const host of new Set(options.rules.flatMap((rule) => rule.hosts))) {
    issuer.issue(host)
  }

  // Closing the shim must also close every per-host listener, or the process
  // hangs on open handles after server.close().
  server.on('close', () => {
    for (const inner of innerServers) inner.close()
  })
  return server
}
