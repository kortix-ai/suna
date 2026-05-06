//@ts-ignore
import type { Context } from 'hono'
import { config } from '../config'
import { serviceManager } from './service-manager'

// 30s timeout for regular requests
const FETCH_TIMEOUT_MS = 30_000
const OPENCODE_HEALTH_TIMEOUT_MS = 5_000
const LOG_COOLDOWN_MS = 60_000
const OPENCODE_FAST_FAIL_MS = 10_000
const OPENCODE_ABORT_TIMEOUT_MS = 5_000

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  // Bun fetch can transparently decode upstream bodies while preserving the
  // upstream Content-Encoding header. If we forward browser gzip/br support to
  // OpenCode and then rebuild a Response, browsers receive plain bytes labeled
  // as gzip and fail with ERR_CONTENT_DECODING_FAILED.
  'accept-encoding',
])

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
])

const seen = new Map<string, number>()
let openCodeFastFailUntil = 0
let openCodeRestartInFlight: Promise<unknown> | null = null

function sanitizeResponseHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const key of STRIP_RESPONSE_HEADERS) headers.delete(key)
  return headers
}

function note(key: string, msg: string): void {
  const now = Date.now()
  const prev = seen.get(key) || 0
  if (now - prev < LOG_COOLDOWN_MS) return
  seen.set(key, now)
  console.error(msg)
}

function markOpenCodeUnhealthy(): void {
  openCodeFastFailUntil = Date.now() + OPENCODE_FAST_FAIL_MS
}

function clearOpenCodeUnhealthy(): void {
  openCodeFastFailUntil = 0
}

function recover(path: string): boolean {
  return path !== '/file/status'
}

function isOpenCodeAbortRequest(method: string, path: string): boolean {
  return method === 'POST' && /^\/session\/[^/]+\/abort$/.test(path)
}

function scheduleOpenCodeRestart(reason: string): void {
  if (openCodeRestartInFlight) return
  openCodeRestartInFlight = serviceManager.restartService('opencode-serve')
    .then((result) => {
      if (!result.ok) {
        console.warn(`[Kortix Master] OpenCode restart failed (${reason}): ${result.output}`)
      }
    })
    .catch((err) => {
      console.warn(`[Kortix Master] OpenCode restart failed (${reason}): ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => {
      openCodeRestartInFlight = null
    })
}

async function isOpenCodeConnectable(): Promise<boolean> {
  try {
    const res = await fetch(`http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}/global/health`, {
      signal: AbortSignal.timeout(OPENCODE_HEALTH_TIMEOUT_MS),
    })
    await res.arrayBuffer().catch(() => {})
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('ECONNREFUSED') || message.includes('Unable to connect') || message.includes('Connection refused')) {
      return false
    }
    // A health timeout means OpenCode is overloaded or busy, not necessarily
    // gone. Avoid entering fast-fail mode unless the TCP connection is refused.
    return true
  }
}

export async function proxyToOpenCode(c: Context): Promise<Response> {
  const url = new URL(c.req.url)
  const targetUrl = `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}${url.pathname}${url.search}`
  const isAbortRequest = isOpenCodeAbortRequest(c.req.method, url.pathname)
  const requestTimeoutMs = isAbortRequest ? OPENCODE_ABORT_TIMEOUT_MS : FETCH_TIMEOUT_MS
  const requestBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    ? await c.req.raw.arrayBuffer()
    : undefined

  // Build headers, forwarding most but not Host
  const headers = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  }

  // Detect if this is likely an SSE request (Accept: text/event-stream)
  const acceptsSSE = (c.req.header('accept') || '').includes('text/event-stream')

  if (Date.now() < openCodeFastFailUntil) {
    return c.json({
      error: 'OpenCode not responding',
      details: 'OpenCode is currently restarting or unavailable',
    }, 503)
  }

  async function fetchUpstream(): Promise<Response> {
    // For SSE: use an AbortController linked to the client request's signal
    // so when the client disconnects, we abort the upstream fetch too.
    // For regular requests: use a 30s timeout.
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | null = null

    if (acceptsSSE) {
      // If the client request has a signal (Bun provides this when client disconnects),
      // propagate its abort to our controller
      const clientSignal = c.req.raw.signal
      if (clientSignal) {
        if (clientSignal.aborted) {
          controller.abort()
        } else {
          clientSignal.addEventListener('abort', () => controller.abort(), { once: true })
        }
      }
    } else {
      timer = setTimeout(() => controller.abort(), requestTimeoutMs)
      signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer)
      }, { once: true })
    }

    try {
      return await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: requestBody ? requestBody.slice(0) : undefined,
        // @ts-ignore - Bun supports duplex
        duplex: 'half',
        signal,
      })
    } finally {
      // The timeout protects "no upstream headers" cases. Once OpenCode has
      // answered, do not abort a slow/large body read, especially huge
      // /session/:id/message payloads.
      if (timer) clearTimeout(timer)
    }
  }

  try {
    const response = await fetchUpstream()
    if (response.ok) clearOpenCodeUnhealthy()

    // Check if this is an SSE/streaming response — pass body as stream
    const contentType = response.headers.get('content-type') || ''
    const shouldStreamJson =
      response.ok &&
      c.req.method === 'GET' &&
      /^\/session\/[^/]+\/message$/.test(url.pathname)
    if (contentType.includes('text/event-stream') || contentType.includes('application/octet-stream') || shouldStreamJson) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeResponseHeaders(response.headers),
      })
    }

    // Buffer the response body to avoid Bun ReadableStream proxy issues
    const body = await response.arrayBuffer()

    // Log upstream errors so they're visible in the container logs
    if (response.status >= 500) {
      try {
        const text = new TextDecoder().decode(body).slice(0, 500)
        // Try to extract a meaningful error message from JSON response
        const parsed = JSON.parse(text)
        const errMsg = parsed?.data?.message || parsed?.message || parsed?.error || text.slice(0, 200)
        console.error(`[Kortix Master] OpenCode ${response.status} on ${c.req.method} ${url.pathname}: ${errMsg}`)
      } catch {
        const text = new TextDecoder().decode(body).slice(0, 200)
        // Check for Bun's HTML error fallback (module resolution errors, etc.)
        if (text.includes('__bunfallback')) {
          // Extract the base64 error from Bun's fallback page
          const b64Match = new TextDecoder().decode(body).match(/type="binary\/peechy">\s*([\w+/=]+)\s*</)
          if (b64Match) {
            console.error(`[Kortix Master] OpenCode ${response.status} on ${c.req.method} ${url.pathname}: Bun startup crash (module resolution or compile error — check OpenCode logs)`)
          } else {
            console.error(`[Kortix Master] OpenCode ${response.status} on ${c.req.method} ${url.pathname}: Bun error page returned (check OpenCode logs)`)
          }
        } else {
          console.error(`[Kortix Master] OpenCode ${response.status} on ${c.req.method} ${url.pathname}: ${text || '(empty response)'}`)
        }
      }
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
    })
  } catch (error) {
    // Handle abort/timeout errors cleanly (Bun throws TimeoutError for AbortSignal.timeout,
    // AbortError for manual controller.abort())
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      if (!acceptsSSE) {
        if (isAbortRequest) {
          markOpenCodeUnhealthy()
          scheduleOpenCodeRestart(`abort-timeout:${url.pathname}`)
          note(
            `timeout:${c.req.method}:${url.pathname}`,
            `[Kortix Master] OpenCode abort timed out on ${url.pathname} after ${requestTimeoutMs / 1000}s; restarting runtime`,
          )
          return c.json(true)
        }
        const connectable = await isOpenCodeConnectable()
        if (!connectable) markOpenCodeUnhealthy()
        // A timed-out data endpoint usually means OpenCode is busy handling a
        // large session, not that the process is dead. Do not restart it here:
        // process-level recovery is reserved for connect failures and watchdog
        // TCP probes.
        note(
          `timeout:${c.req.method}:${url.pathname}`,
          `[Kortix Master] OpenCode timeout on ${c.req.method} ${url.pathname} after ${requestTimeoutMs / 1000}s`,
        )
        return c.json({ error: 'OpenCode not responding', details: `${url.pathname} timed out after ${requestTimeoutMs / 1000}s — OpenCode may be busy or temporarily unavailable` }, 504)
      }
      // SSE client disconnected — just return empty response (connection is already gone)
      return new Response(null, { status: 499 })
    }
    const errMsg = error instanceof Error ? error.message : String(error)
    const isConnRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('Unable to connect')
    if (isConnRefused) {
      markOpenCodeUnhealthy()
      note(
        `unreachable:${c.req.method}:${url.pathname}`,
        `[Kortix Master] OpenCode unreachable on ${c.req.method} ${url.pathname}: ${errMsg} — is OpenCode running on ${config.OPENCODE_HOST}:${config.OPENCODE_PORT}?`,
      )
      const recovered = recover(url.pathname)
        ? !!(await serviceManager.requestRecovery('opencode-serve', `proxy-connect:${url.pathname}`))?.ok
        : false
      if (recovered) {
        try {
          const retryResponse = await fetchUpstream()
          const retryContentType = retryResponse.headers.get('content-type') || ''
          if (retryContentType.includes('text/event-stream') || retryContentType.includes('application/octet-stream')) {
            return new Response(retryResponse.body, {
              status: retryResponse.status,
              statusText: retryResponse.statusText,
              headers: sanitizeResponseHeaders(retryResponse.headers),
            })
          }

          const retryBody = await retryResponse.arrayBuffer()
          return new Response(retryBody, {
            status: retryResponse.status,
            statusText: retryResponse.statusText,
            headers: sanitizeResponseHeaders(retryResponse.headers),
          })
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
          note(
            `retry:${c.req.method}:${url.pathname}`,
            `[Kortix Master] OpenCode retry after recovery failed on ${c.req.method} ${url.pathname}: ${retryMsg}`,
          )
          return c.json({ error: 'Failed to proxy to OpenCode after recovery attempt', details: retryMsg }, 502)
        }
      }
    } else {
      note(
        `proxy:${c.req.method}:${url.pathname}`,
        `[Kortix Master] Proxy error on ${c.req.method} ${url.pathname}: ${errMsg}`,
      )
    }
    return c.json({ error: 'Failed to proxy to OpenCode', details: errMsg }, 502)
  }
}
