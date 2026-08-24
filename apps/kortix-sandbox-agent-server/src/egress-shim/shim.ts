/**
 * The in-guest egress shim — the ONE way an egress-enforced secret is spent,
 * identically on daytona, e2b and platinum (docs/specs/
 * 2026-08-19-secrets-exposure-usage-model.md §4).
 *
 * No provider edge serves secrets any more, and one of them never could:
 * Daytona has no credential edge and cannot be pointed at one
 * (`outboundProxyUrl` is accepted and ignored — measured, see
 * docs/NETWORK_BOUNDARY_WITHOUT_PLATINUM.md §7). The way out is to notice the proxy
 * does two separable jobs:
 *
 *   1. terminate the guest's TLS  — can only happen INSIDE the guest
 *   2. hold the credential        — must NOT happen inside the guest
 *
 * Nothing requires those to be the same process, so they are split (§7.4):
 *
 *   agent ──HTTPS──▶ this shim ──HTTPS──▶ Kortix broker route ──▶ upstream
 *                    (ephemeral CA,        (holds the credential, swaps the
 *                     holds NOTHING)        handle for it, redacts the echo)
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
import zlib from 'node:zlib'

import { BLOCKED_REQUEST_HEADERS } from './blocked-headers'
import { LeafIssuer, type EphemeralCa } from './ca'
import {
  canStreamDecode,
  probeRelay,
  relayStreaming,
  RelayRefusedError,
} from './relay-client'
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

// Re-exported from its own module so `relay-client.ts` can read the same set
// without importing this file (which imports it). See ./blocked-headers.ts for
// why the list is a copy and what pins it to the broker's.
export { BLOCKED_REQUEST_HEADERS } from './blocked-headers'

/**
 * The broker's own request ceiling (`MAX_REQUEST_BYTES`,
 * apps/api/src/secrets/http-broker.ts). Decoding past it only produces bytes
 * the broker answers 413 to, so it doubles as the decompression-bomb guard: a
 * 1 KiB gzip that expands to a gigabyte stops here instead of in this process.
 */
const MAX_DECODED_REQUEST_BYTES = 1_048_576

const REQUEST_DECODERS: Record<string, (body: Buffer) => Buffer> = {
  gzip: (body) => zlib.gunzipSync(body, { maxOutputLength: MAX_DECODED_REQUEST_BYTES }),
  'x-gzip': (body) => zlib.gunzipSync(body, { maxOutputLength: MAX_DECODED_REQUEST_BYTES }),
  br: (body) => zlib.brotliDecompressSync(body, { maxOutputLength: MAX_DECODED_REQUEST_BYTES }),
  deflate: (body) => {
    // `deflate` names two wire formats and clients disagree about which they
    // send. Try the zlib-wrapped one, fall back to raw.
    try {
      return zlib.inflateSync(body, { maxOutputLength: MAX_DECODED_REQUEST_BYTES })
    } catch {
      return zlib.inflateRawSync(body, { maxOutputLength: MAX_DECODED_REQUEST_BYTES })
    }
  },
}

/**
 * Undo the guest's request `content-encoding`, or refuse the request.
 *
 * The mirror of forcing `accept-encoding: identity` on the response leg, and
 * the same security control. Substitution is server-side and byte-based: the
 * broker finds a handle in the request body by scanning for it, and a gzipped
 * body does not contain those bytes. Relaying compressed bytes would send the
 * upstream a body still carrying the handle — a worthless string — and hand
 * the agent a 401 with nothing naming why.
 *
 * Null means "cannot be made identity" and is a REFUSAL, not a fallback.
 * Relaying an encoding this function does not understand is exactly the case
 * above with no log line; failing here names it.
 */
export function decodeRequestBody(header: string, body: Buffer): Buffer | null {
  const steps = header
    .split(',')
    .map((step) => step.trim().toLowerCase())
    .filter((step) => step.length > 0 && step !== 'identity')
  let out = body
  // Encodings are listed in the order they were applied, so undo them backwards.
  for (const step of steps.reverse()) {
    const decode = REQUEST_DECODERS[step]
    if (!decode) return null
    try {
      out = decode(out)
    } catch {
      return null
    }
  }
  return out
}

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
 * Hand the guest's request to Kortix, which holds the credential — BUFFERED.
 *
 * This is the original transport and it is PERMANENT, not deprecated. The
 * daemon ships inside the sandbox image and a box booted today can be resumed
 * months from now, so `/broker` must keep working forever; and a
 * `content-encoding: deflate` body genuinely needs a buffered retry (its
 * raw-vs-zlib ambiguity cannot be resolved mid-stream). The construction-time
 * probe picks the transport; both stay.
 *
 * The logic below is unchanged from before the streaming relay existed. Only
 * the I/O shape moved — from `http.IncomingMessage`/`ServerResponse` to
 * `Request`/`Response` — because the inner listener is now `Bun.serve` (see
 * `listenerFor`).
 */
async function relayBuffered(
  options: EgressShimOptions,
  rule: ShimBrokerRule,
  host: string,
  request: Request,
  body: Buffer,
): Promise<Response> {
  // Forward only the request's own headers. Nothing secret is added here —
  // that is the entire point of this mode.
  const forwarded: Record<string, string> = {}
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase()
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue
    forwarded[lower] = value
  }
  // Force identity, ALWAYS, overriding whatever the guest asked for.
  //
  // This is a security control, not a compatibility tweak. Kortix redacts an
  // echoed credential by scanning the response bytes; a gzipped body does not
  // contain those bytes, so the scan finds nothing and the credential is
  // returned to the guest intact. The broker itself now forces `identity` on
  // its upstream leg for exactly this reason (it DROPS any caller value rather
  // than 400ing it, so this line and every already-deployed daemon that sends
  // it keep working); the shim sets it too so a plain `curl` (which offers gzip
  // by default) still gets an uncompressed body end to end.
  //
  // It is also the only correct answer for the guest: `content-encoding` is not
  // in the broker's response-header whitelist, so compressed bytes would arrive
  // with nothing saying they were compressed.
  forwarded['accept-encoding'] = 'identity'

  // The REQUEST leg gets the same treatment, for the mirror-image reason:
  // substitution scans the outgoing bytes for the handle, and a compressed
  // body does not contain them. Undo the encoding here so Kortix sees raw
  // bytes, and drop the header so the upstream is told what it actually gets.
  let payload = body
  const contentEncoding = request.headers.get('content-encoding')
  if (typeof contentEncoding === 'string' && contentEncoding.trim().length > 0) {
    delete forwarded['content-encoding']
    // An empty body carries no handle, so there is nothing to make visible and
    // nothing to refuse — a `Content-Encoding` on a bodyless GET is a spurious
    // header, not a request the shim should reject.
    const decoded = body.length === 0 ? body : decodeRequestBody(contentEncoding, body)
    if (!decoded) {
      // Refuse rather than relay. The alternative is a request whose handle is
      // never substituted, an upstream 401, and an agent with nothing to read.
      return new Response(
        JSON.stringify({
          error:
            `kortix egress shim: cannot relay a request body encoded as ` +
            `'${contentEncoding}'. Send it uncompressed.`,
          code: 'unsupported_request_encoding',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    payload = decoded
  }

  const call = options.brokerFetch ?? fetch
  const target = new URL(request.url)
  const url =
    `${options.apiUrl.replace(/\/$/, '')}/projects/${options.projectId}` +
    `/secrets/${encodeURIComponent(rule.identifier)}/broker`
  const response = await call(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `https://${host}${target.pathname}${target.search}`,
      method: request.method.toUpperCase(),
      ...(Object.keys(forwarded).length > 0 ? { headers: forwarded } : {}),
      ...(payload.length > 0 ? { body_base64: payload.toString('base64') } : {}),
    }),
    signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
  })

  if (!response.ok) {
    // Surface Kortix's own refusal verbatim: a denied grant or an out-of-policy
    // host must reach the agent as that, not as a generic proxy error it will
    // waste a turn guessing about.
    const detail = await response.text().catch(() => '')
    return new Response(detail || JSON.stringify({ error: 'broker refused the request' }), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
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
  return new Response(out, { status: result.status ?? 502, headers })
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
  /**
   * The per-connection rule, keyed by the loopback SOURCE PORT.
   *
   * Unique per connection, and — verified through the real CONNECT pipe — equal
   * to what the inner listener reports as `server.requestIP(req)?.port` and what
   * this side sees as `inner.localPort`.
   */
  interface Binding {
    rule: ShimBrokerRule
    host: string
    /**
     * Destroy this guest connection.
     *
     * The ONLY way to tell the guest "this response is incomplete". Measured on
     * bun 1.3.14: erroring a `Response` body stream still emits a clean
     * `0\r\n\r\n` and the client's fetch/curl succeeds, so framing carries no
     * failure signal in either direction. Killing the TLS connection does: curl
     * reports `transfer closed with outstanding read data remaining` and exits
     * non-zero instead of handing the agent half a document.
     */
    abort(): void
  }
  const bindings = new Map<number, Binding>()

  /**
   * Which transport this shim uses, decided ONCE at construction.
   *
   * Not per request, and that is deliberate: a streamed body that has already
   * been consumed cannot be replayed onto a fallback, so the choice has to be
   * made before any body exists. `syncEgressShim` tears the shim down and
   * rebuilds it on a live capability push, so a re-probe happens naturally
   * there. See relay-client.ts.
   */
  let relaySupported = false
  /**
   * The in-flight construction-time probe, or null once its answer is in.
   *
   * Awaited on the FIRST relayed request instead of at construction: awaiting it
   * in `createEgressShim` put a 5 s network round trip in front of
   * `startProxy()`, so `/kortix/health` answered nothing for that whole window
   * and the readiness poller saw a closed port — the exact failure the comment
   * block in main.ts exists to prevent. Same cost is paid again on fork
   * adoption and on every live capability push through `syncEgressShim`.
   */
  let relayProbe: Promise<boolean> | null = null

  async function serveTerminated(request: Request, binding: Binding): Promise<Response> {
    // `content-encoding: deflate` cannot be undone in a stream (raw vs zlib is
    // decided by a retry), so those requests take the buffered path and keep
    // today's 1 MiB decompression-bomb guard. Everything else streams.
    const contentEncoding = request.headers.get('content-encoding')?.trim() ?? ''
    const streamable =
      contentEncoding === '' ||
      contentEncoding.toLowerCase() === 'identity' ||
      canStreamDecode(contentEncoding)

    if (relayProbe) {
      relaySupported = await relayProbe.catch(() => false)
      relayProbe = null
    }

    // A bodyless request is trivially replayable, so a transport downgrade can
    // be recovered from IN THIS TURN rather than only on the next call.
    const replayable =
      request.body === null || request.method === 'GET' || request.method === 'HEAD'

    if (relaySupported && streamable) {
      try {
        return await relayStreaming(options, binding.rule, binding.host, request, binding.abort)
      } catch (err) {
        if (err instanceof RelayRefusedError) {
          if (err.downgrade) {
            // /relay is gone — the kill switch, or an API rolled back under a
            // live sandbox. `/broker` is permanent and still works; use it for
            // the rest of this process's life.
            relaySupported = false
            if (replayable) {
              return await relayBuffered(
                options,
                binding.rule,
                binding.host,
                request,
                Buffer.alloc(0),
              )
            }
          }
          return new Response(err.payload, {
            status: err.status,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw err
      }
    }
    // Buffered: read the whole body first, exactly as before.
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0)
    return await relayBuffered(options, binding.rule, binding.host, request, body)
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
   *
   * ## Why `Bun.serve` and not `https.createServer`
   *
   * Two reasons, both measured, and one of them is a hard blocker:
   *
   *  1. **Websockets are impossible on the node path.** `inner.on('upgrade')`
   *     under Bun hands you a socket that is an inert stub in BOTH directions —
   *     not `instanceof net.Socket`, `_handle.fd` undefined, `write()` returns
   *     `true` while dropping the bytes, and client bytes sent after the upgrade
   *     never arrive. Node v22.22.0 delivers all of it. There is no workaround
   *     at the node:http layer because there is no fd to recover. That is why
   *     the old code simply destroyed the socket and the client hung with no log
   *     line.
   *  2. **Streaming needs a web `ReadableStream` body**, which is what a
   *     `Bun.serve` `fetch` handler gets and `req.on('data')` is not.
   *
   * The outer CONNECT proxy STAYS on node:http — `Bun.serve` cannot handle HTTP
   * CONNECT, and the node one works (verified: `200 Connection Established`, a
   * byte-transparent tunnel, and a 101 through it).
   *
   * Accepted fidelity loss: Bun's parser lowercases header names and collapses
   * duplicate non-known headers to the LAST value at the guest edge. No worse
   * than before — the old code's `if (typeof value === 'string')` already
   * dropped every multi-value header — and `x-kortix-relay-meta` stops a SECOND
   * collapse on the shim → API hop.
   */
  const listeners = new Map<string, Promise<number>>()
  const innerServers: Array<{ stop(closeActiveConnections?: boolean): void }> = []
  function listenerFor(host: string): Promise<number> {
    const existing = listeners.get(host)
    if (existing) return existing
    const started = (async () => {
      const leaf = issuer.issue(host)
      const inner = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        tls: { cert: leaf.certPem, key: leaf.keyPem },
        // Bun's default is 10s and its MAX is 255s, and it is an IDLE timer that
        // server->client writes do not reset. Any fixed ceiling kills a healthy
        // SSE stream — the exact shape of the gateway idleTimeout incident.
        idleTimeout: 0,
        async fetch(request: Request, server): Promise<Response> {
          const sourcePort = server.requestIP(request)?.port ?? -1
          const binding = bindings.get(sourcePort)
          if (!binding) {
            return new Response('kortix egress shim: no rule bound to connection', { status: 500 })
          }
          if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            // A REAL response, which the node:http upgrade handler could not
            // write at all. Even the unsupported path now tells the agent why
            // instead of resetting the socket and letting it time out silently.
            fail('upgrade', new Error('websocket relay is not enabled'))
            return new Response(
              JSON.stringify({
                error: 'kortix egress shim: websocket relay is not enabled',
                code: 'websocket_relay_unavailable',
              }),
              { status: 501, headers: { 'content-type': 'application/json' } },
            )
          }
          try {
            return await serveTerminated(request, binding)
          } catch (err) {
            fail('broker', err as Error)
            return new Response('kortix egress shim: broker relay failed', { status: 502 })
          }
        },
      })
      innerServers.push(inner)
      // `port` is optional in the type because a Bun server can be bound to a
      // unix socket; ours is always TCP on 127.0.0.1.
      const bound = inner.port
      if (bound === undefined) throw new Error('kortix egress shim: inner listener has no port')
      return bound
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
          bindings.set(inner.localPort ?? -1, {
            rule,
            host: target.host,
            abort: () => {
              // Both ends: `inner` is the loopback leg into our TLS listener,
              // `socket` is the guest's own CONNECT tunnel. Destroying them is
              // what turns a truncated relay into a visible transport error.
              inner.destroy()
              socket.destroy()
            },
          })
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

  // Ask ONCE whether Kortix speaks the streaming relay, beside the leaf warm-up
  // so it costs nothing on the request path. Anything but a 204 — a 404 from an
  // older self-hosted API, a 503 from the kill switch, a timeout — leaves this
  // shim on the permanent buffered `/broker` transport for its whole life.
  const probeIdentifier = options.rules[0]?.identifier
  if (probeIdentifier) {
    // NOT awaited: `startEgressShim` is awaited before `startProxy()` binds the
    // daemon's health port, so blocking here for up to PROBE_TIMEOUT_MS leaves
    // every readiness poll hitting a closed port. The first relayed request
    // awaits the answer instead.
    relayProbe = probeRelay(options, probeIdentifier).then((ok) => {
      relaySupported = ok
      return ok
    })
    relayProbe.catch(() => undefined)
  }

  // Closing the shim must also close every per-host listener, or the process
  // hangs on open handles after server.close().
  server.on('close', () => {
    // Bun.serve servers are NOT https.Server and have no `.close()`. Without
    // `.stop(true)` the process hangs on open handles after shutdown, and
    // `syncEgressShim`'s stop-then-start re-arm (which rebinds the same port)
    // fails on every live capability push.
    for (const inner of innerServers) inner.stop(true)
  })
  return server
}
