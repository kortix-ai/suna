/**
 * The shim's STREAMING transport to Kortix.
 *
 * The buffered path (`relayBuffered`, in shim.ts) base64s the whole request
 * into a JSON envelope and buffers the whole response back. That is where the
 * 1 MiB / 5 MiB caps come from, and why SSE and websockets are impossible. This
 * module is the replacement: the guest's body bytes go up the wire verbatim as
 * `application/octet-stream`, everything else rides in `x-kortix-relay-meta`,
 * and the response body streams back.
 *
 * The credential situation is UNCHANGED and is the whole point: this file, like
 * the rest of the shim, holds no secret value. It ships a handle; Kortix swaps
 * it server-side and redacts the echo on the way back.
 *
 * ## Why `fetch` here, when the API's upstream leg deliberately does not
 *
 * There is nothing to IP-pin on this hop — the destination is Kortix itself, a
 * name the daemon was configured with. Bun's `fetch` sends a `ReadableStream`
 * body incrementally with chunked encoding and no content-length (verified:
 * sender-to-receiver chunk alignment exact), and it is effectively full-duplex
 * despite the name, so response bytes flow while request bytes are still going
 * out — which is exactly what makes SSE-over-POST work.
 *
 * `duplex: 'half'` is REQUIRED by Node and ignored by Bun. It is always sent:
 * free portability, and the daemon's tests may run under either.
 *
 * ## Why the capability probe runs at construction and not per request
 *
 * A streamed body that has already been consumed cannot be replayed onto a
 * fallback. If the transport choice were made per request, a `/relay` that
 * turned out to be missing would leave the request unrecoverable. So the shim
 * asks ONCE, off the request path, and remembers for its process lifetime.
 * `syncEgressShim` tears the shim down and rebuilds it on a live capability
 * push, so a re-probe happens naturally there.
 */
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'

import {
  decodeRelayStatus,
  encodeRelayMeta,
  RELAY_ERROR_HEADER,
  RELAY_META_HEADER,
  RELAY_PROBE_HEADER,
  RELAY_STATUS_HEADER,
  RELAY_VERSION,
  RELAY_VERSION_HEADER,
  type RelayMethod,
  type SecretRelayMeta,
} from '@kortix/api-contract/secret-relay'

import { BLOCKED_REQUEST_HEADERS } from './blocked-headers'
import type { ShimBrokerRule } from './rules'

/** Everything the relay client needs from the shim's options. */
export interface RelayClientOptions {
  readonly apiUrl: string
  readonly projectId: string
  readonly token: string
  readonly brokerFetch?: typeof fetch
}

/** How long the one-shot capability probe may take before we assume legacy. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Stream decompressors for the REQUEST leg.
 *
 * `deflate` is deliberately absent. It names two wire formats and clients
 * disagree about which they send, so the buffered decoder tries zlib and falls
 * back to raw — a retry that cannot be done on a stream, because the first
 * bytes are already gone by the time the failure shows. Those requests take the
 * buffered path and keep today's 1 MiB bomb guard. Named in the error, not
 * silently degraded.
 */
const STREAM_DECODERS: Record<string, () => zlib.Gunzip | zlib.BrotliDecompress> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  br: () => zlib.createBrotliDecompress(),
}

export function canStreamDecode(contentEncoding: string): boolean {
  const steps = contentEncoding
    .split(',')
    .map((step) => step.trim().toLowerCase())
    .filter((step) => step.length > 0 && step !== 'identity')
  return steps.length > 0 && steps.every((step) => step in STREAM_DECODERS)
}

function relayUrl(options: RelayClientOptions, identifier: string): string {
  return (
    `${options.apiUrl.replace(/\/$/, '')}/projects/${options.projectId}` +
    `/secrets/${encodeURIComponent(identifier)}/relay`
  )
}

/**
 * Ask Kortix once whether it speaks the streaming relay.
 *
 * Anything other than a 204 carrying the protocol header — a 404 from an older
 * self-hosted API, a 503 `relay_disabled` from the kill switch, a timeout —
 * means legacy `/broker` for this process's whole life. That is a deliberate
 * fail-CLOSED-to-the-old-path: the buffered route always works.
 */
export async function probeRelay(
  options: RelayClientOptions,
  identifier: string,
): Promise<boolean> {
  const call = options.brokerFetch ?? fetch
  try {
    const response = await call(relayUrl(options, identifier), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        [RELAY_PROBE_HEADER]: '1',
        [RELAY_VERSION_HEADER]: String(RELAY_VERSION),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // Drain, so the connection can be reused rather than left half-read.
    await response.arrayBuffer().catch(() => undefined)
    return response.status === 204 && response.headers.get(RELAY_VERSION_HEADER) === '1'
  } catch {
    return false
  }
}

/**
 * Build the meta header from the guest's request.
 *
 * Header ORDER and DUPLICATES are preserved here because this is the last point
 * at which they still exist: Bun's parser has already collapsed duplicate
 * non-known headers at the guest edge (no worse than the buffered path, which
 * dropped every multi-value header outright), and putting the list in the body
 * of a JSON envelope is what the streaming contract removes. Shipping them as
 * one opaque field stops a SECOND collapse on the shim → API hop.
 */
export function buildRelayMeta(input: {
  url: string
  method: string
  headers: Iterable<[string, string]>
  bodyLength: number | null
  hasBody: boolean
}): SecretRelayMeta {
  const headers: Array<[string, string]> = []
  for (const [rawName, value] of input.headers) {
    const name = rawName.toLowerCase()
    if (BLOCKED_REQUEST_HEADERS.has(name)) continue
    // The shim's own framing decision — see below — supersedes whatever the
    // guest declared, and `content-encoding` is undone on this side.
    if (name === 'accept-encoding' || name === 'content-encoding') continue
    headers.push([name, value])
  }
  // ALWAYS identity, overriding the guest. A compressed echo cannot be redacted:
  // the API scans response bytes for the secret, and gzip does not contain them.
  headers.push(['accept-encoding', 'identity'])
  return {
    v: RELAY_VERSION,
    url: input.url,
    method: input.method.toUpperCase() as RelayMethod,
    headers,
    body: input.hasBody ? { present: true, length: input.bodyLength } : { present: false },
    // This client strips and verifies the end-of-stream sentinel, so ask for
    // one. Without it a truncated relay is INVISIBLE: measured on bun 1.3.14,
    // an errored response body stream still gets a clean `0\r\n\r\n`
    // terminator and `fetch` resolves normally, so the agent would parse half a
    // JSON document as the whole answer. See RELAY_EOS_BYTES.
    eos: true,
  }
}

/** The relay refused before reaching the upstream — forwarded to the guest verbatim. */
export class RelayRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly payload: string,
    /**
     * `true` ⟺ the refusal means "/relay is not available here", not "your
     * request was denied". The shim reacts by permanently falling back to the
     * buffered `/broker` transport.
     */
    readonly downgrade: boolean = false,
  ) {
    super(`kortix relay refused: ${code ?? status}`)
    this.name = 'RelayRefusedError'
  }
}

/**
 * Does this refusal mean the streaming relay is GONE rather than that the
 * request was denied?
 *
 * The two documented incident levers are `KORTIX_SECRET_RELAY_STREAM_ENABLED=false`
 * (503 `relay_disabled`) and rolling the API back (404, or 501 from a
 * self-hosted build). A shim that probed 204 at construction and never revised
 * the verdict turned BOTH levers into "every boundary-secret sandbox now fails
 * every egress call until its session restarts", while `/broker` was up and
 * working the whole time. So the verdict is revisable, in exactly these cases
 * and no others — a 403 policy denial must never downgrade the transport.
 */
function isTransportGone(status: number, code: string | null): boolean {
  return status === 404 || status === 501 || code === 'relay_disabled'
}

/**
 * Relay one guest request through Kortix, streaming both ways.
 *
 * Returns the response to hand back to the guest, already reconstructed from
 * `x-kortix-relay-status`. The body is the relay's body stream — NOT copied,
 * NOT buffered — so the guest sees each SSE event as it arrives.
 */
export async function relayStreaming(
  options: RelayClientOptions,
  rule: ShimBrokerRule,
  host: string,
  request: Request,
  /**
   * Called when the relay body ended WITHOUT its end-of-stream sentinel — i.e.
   * the guest is about to be handed a truncated response. The shim's only
   * honest reaction is to destroy the guest's connection, because it cannot
   * signal truncation through framing either (same Bun behaviour, same
   * measurement). A clean 200 carrying half an answer is the outcome this
   * callback exists to prevent.
   */
  onTruncated?: () => void,
): Promise<Response> {
  const call = options.brokerFetch ?? fetch
  const contentEncoding = request.headers.get('content-encoding')?.trim() ?? ''
  const declared = request.headers.get('content-length')
  const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'

  let body: ReadableStream<Uint8Array> | null = null
  let bodyLength: number | null = null
  if (hasBody && request.body) {
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
      // Decompressed length is not knowable without decompressing, so the API
      // is told `null` and picks chunked framing. Correct, not lossy.
      body = decompressStream(request.body, contentEncoding)
      bodyLength = null
    } else {
      body = request.body
      bodyLength = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null
    }
  }

  const meta = buildRelayMeta({
    url: `https://${host}${new URL(request.url).pathname}${new URL(request.url).search}`,
    method: request.method,
    headers: request.headers as unknown as Iterable<[string, string]>,
    bodyLength,
    hasBody: body !== null,
  })

  const response = await call(relayUrl(options, rule.identifier), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/octet-stream',
      [RELAY_VERSION_HEADER]: String(RELAY_VERSION),
      [RELAY_META_HEADER]: encodeRelayMeta(meta),
    },
    ...(body !== null ? { body, duplex: 'half' } : {}),
  } as RequestInit)

  const statusHeader = response.headers.get(RELAY_STATUS_HEADER)
  if (!statusHeader) {
    // No status header ⟺ Kortix itself refused or failed. Surface its own JSON
    // envelope verbatim: a denied grant or an out-of-policy host must reach the
    // agent as THAT, not as a generic proxy error it will waste a turn guessing
    // about. Exactly what the buffered path already does.
    const detail = await response.text().catch(() => '')
    const code = response.headers.get(RELAY_ERROR_HEADER)
    throw new RelayRefusedError(
      response.status,
      code,
      detail || JSON.stringify({ error: 'kortix relay refused the request' }),
      isTransportGone(response.status, code),
    )
  }

  const status = decodeRelayStatus(statusHeader)
  const headers = new Headers()
  for (const [name, value] of status.headers) headers.append(name, value)
  // NEVER copy a content-length: the body streams, and Bun frames a streamed
  // `Response` body as chunked automatically. (The buffered path keeps its
  // explicit content-length line — deleting both headers there leaves the
  // response held under Bun, already measured; see shim.ts.)
  let responseBody = response.body
  if (responseBody && status.eos) {
    // The cast is a lib difference, not a lie: this file is typechecked by BOTH
    // the daemon's tsconfig (`lib: ESNext`, where `Uint8Array` defaults to
    // `Uint8Array<ArrayBufferLike>`) and apps/api's (which resolves it to
    // `Uint8Array<ArrayBuffer>`). Same bytes, same stream.
    responseBody = verifyEndOfStream(
      responseBody as ReadableStream<Uint8Array>,
      Buffer.from(status.eos, 'hex'),
      onTruncated,
    ) as typeof responseBody
  }
  return new Response(responseBody, { status: status.status, headers })
}

/**
 * Strip and verify the end-of-stream sentinel.
 *
 * Holds back the last `RELAY_EOS_BYTES` bytes seen so far and releases them
 * only once more data proves they were not the tail. On a clean end the held
 * bytes must equal the sentinel; anything else — a short read, a reset, a
 * source error — means the relay was truncated, so the held bytes are emitted
 * (they were real data) and `onTruncated` fires.
 *
 * Hand-rolled rather than a `TransformStream` on purpose: a transform's
 * `flush()` does not run when the source ERRORS, and "the source errored" is
 * one of the two truncation shapes this has to catch.
 */
function verifyEndOfStream(
  source: ReadableStream<Uint8Array>,
  sentinel: Buffer,
  onTruncated?: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let held = new Uint8Array(0)
  let finished = false
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, clean: boolean) => {
    if (finished) return
    finished = true
    if (!clean) {
      if (held.byteLength > 0) controller.enqueue(held)
      held = new Uint8Array(0)
      onTruncated?.()
    }
    controller.close()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let result: { done?: boolean; value?: Uint8Array }
        try {
          result = await reader.read()
        } catch {
          finish(controller, false)
          return
        }
        if (result.done) {
          const clean =
            held.byteLength === sentinel.byteLength && Buffer.from(held).equals(sentinel)
          finish(controller, clean)
          return
        }
        const chunk = result.value
        if (!chunk || chunk.byteLength === 0) continue
        const merged = new Uint8Array(held.byteLength + chunk.byteLength)
        merged.set(held, 0)
        merged.set(chunk, held.byteLength)
        if (merged.byteLength <= sentinel.byteLength) {
          held = merged
          continue
        }
        const cut = merged.byteLength - sentinel.byteLength
        // `slice` COPIES: `merged` is handed to the consumer below.
        held = merged.slice(cut)
        controller.enqueue(merged.subarray(0, cut))
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/**
 * Undo the guest's `content-encoding` AS A STREAM.
 *
 * The mirror of forcing `accept-encoding: identity` on the response leg, and
 * the same security control: substitution is byte-based and server-side, so a
 * gzipped body does not contain the handle's bytes and the request would leave
 * carrying a worthless string.
 */
function decompressStream(
  source: ReadableStream<Uint8Array>,
  contentEncoding: string,
): ReadableStream<Uint8Array> {
  const steps = contentEncoding
    .split(',')
    .map((step) => step.trim().toLowerCase())
    .filter((step) => step.length > 0 && step !== 'identity')
  let stream = source
  // Encodings are listed in the order they were applied, so undo them backwards.
  for (const step of steps.reverse()) {
    const make = STREAM_DECODERS[step]
    if (!make) throw new Error(`kortix egress shim: cannot stream-decode '${step}'`)
    stream = pipeThroughZlib(stream, make())
  }
  return stream
}

function pipeThroughZlib(
  source: ReadableStream<Uint8Array>,
  transform: zlib.Gunzip | zlib.BrotliDecompress,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      transform.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      transform.on('end', () => controller.close())
      transform.on('error', (error) => controller.error(error))
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            transform.write(Buffer.from(value))
          }
          transform.end()
        } catch (error) {
          transform.destroy(error as Error)
        }
      })()
    },
    cancel(reason) {
      transform.destroy()
      return reader.cancel(reason)
    },
  })
}
