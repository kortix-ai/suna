/**
 * Response helpers for the Kortix Runtime API (`/kortix/opencode/*`).
 *
 * GZIP. Nothing on the sandbox read path is compressed today — measured, the
 * projections these routes serve shrink 2.6x on top of the projection's own
 * 153x (WS-V §3.4/§3.5), and the bytes travel over an edge hop where they cost
 * far more than the ~0.2 ms of CPU inside the VM. Below
 * {@link GZIP_MIN_BYTES} a compressed body is not reliably smaller than the
 * original once the 18-byte gzip envelope is counted, so small answers go out
 * plain. SSE is NEVER compressed: a gzip stream buffers, and a buffered event
 * stream is a broken event stream.
 *
 * SERVER-TIMING. Every response carries `read` (time actually spent reading
 * OpenCode or SQLite) and `total`. It is the only way to tell "the box was
 * slow" from "the network was slow" from a browser waterfall, and the question
 * came up on every latency investigation this repo has run.
 */

/** Below this, gzip is not worth the envelope. */
export const GZIP_MIN_BYTES = 1024

export function acceptsGzip(header: string | null | undefined): boolean {
  if (!header) return false
  return /(^|,)\s*gzip\s*(;|,|$)/i.test(header)
}

export interface TimedJsonOptions {
  status?: number
  /** Milliseconds spent reading the underlying source. */
  readMs?: number
  /** Milliseconds since the request entered the handler. */
  totalMs?: number
  etag?: string
  acceptEncoding?: string | null
  /** Extra `Server-Timing` metrics, `name` -> milliseconds. */
  timings?: Record<string, number>
  headers?: Record<string, string>
}

export function serverTimingHeader(
  readMs: number | undefined,
  totalMs: number | undefined,
  extra: Record<string, number> = {},
): string {
  const parts: string[] = []
  if (readMs !== undefined) parts.push(`read;dur=${readMs.toFixed(1)}`)
  for (const [name, ms] of Object.entries(extra)) parts.push(`${name};dur=${ms.toFixed(1)}`)
  if (totalMs !== undefined) parts.push(`total;dur=${totalMs.toFixed(1)}`)
  return parts.join(', ')
}

/**
 * Serialise, optionally gzip, and stamp the timing headers.
 *
 * The body is serialised ONCE and its byte length reported in
 * `X-Kortix-Bytes` (uncompressed) so a client, a test, or a log line can see
 * the projection's real size without decompressing.
 */
export function timedJson(value: unknown, options: TimedJsonOptions = {}): Response {
  const json = JSON.stringify(value)
  const raw = Buffer.from(json, 'utf8')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Kortix-Bytes': String(raw.byteLength),
    ...(options.headers ?? {}),
  }
  if (options.etag) headers.ETag = options.etag
  const timing = serverTimingHeader(options.readMs, options.totalMs, options.timings)
  if (timing) headers['Server-Timing'] = timing

  if (raw.byteLength >= GZIP_MIN_BYTES && acceptsGzip(options.acceptEncoding)) {
    const gz = Bun.gzipSync(raw)
    // Only if it actually helped. A pre-compressed or high-entropy payload can
    // come back larger, and shipping that would make the route slower.
    if (gz.byteLength < raw.byteLength) {
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
      return new Response(gz, { status: options.status ?? 200, headers })
    }
  }
  headers.Vary = 'Accept-Encoding'
  return new Response(raw, { status: options.status ?? 200, headers })
}

/** 304 with the headers a conditional request still needs. */
export function notModified(etag: string, totalMs?: number): Response {
  const headers: Record<string, string> = { ETag: etag, 'Cache-Control': 'no-store' }
  const timing = serverTimingHeader(0, totalMs)
  if (timing) headers['Server-Timing'] = timing
  return new Response(null, { status: 304, headers })
}

/**
 * Does this `If-None-Match` match `etag`?
 *
 * Handles the list form and the `W/` weak prefix a proxy may add. `*` matches
 * anything, per RFC 9110.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  const normalize = (value: string) => value.trim().replace(/^W\//, '')
  const target = normalize(etag)
  return ifNoneMatch
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === target)
}
