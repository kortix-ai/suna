//@ts-ignore
import type { Context } from 'hono'
import { config } from '../config'
import { serviceManager } from './service-manager'
import { getMember } from './member-context'
import {
  ensureMemberDaemon,
  invalidateSupervisorCache,
  isIsolationEnabled,
} from './supervisor-client'

// 30s timeout for regular requests
const FETCH_TIMEOUT_MS = 30_000
const OPENCODE_HEALTH_TIMEOUT_MS = 1_500
const LOG_COOLDOWN_MS = 60_000

const seen = new Map<string, number>()

function note(key: string, msg: string): void {
  const now = Date.now()
  const prev = seen.get(key) || 0
  if (now - prev < LOG_COOLDOWN_MS) return
  seen.set(key, now)
  console.error(msg)
}

function recover(path: string): boolean {
  return path !== '/file/status'
}

async function isOpenCodeHealthy(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/session`, {
      signal: AbortSignal.timeout(OPENCODE_HEALTH_TIMEOUT_MS),
    })
    await res.arrayBuffer().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}

interface Target {
  host: string
  port: number
  supabaseUserId: string | null
}

async function resolveTarget(c: Context): Promise<Target> {
  const legacy: Target = {
    host: config.OPENCODE_HOST,
    port: config.OPENCODE_PORT,
    supabaseUserId: null,
  }
  if (!isIsolationEnabled()) return legacy
  const member = getMember(c)
  if (!member) return legacy
  const port = await ensureMemberDaemon(member)
  return { host: '127.0.0.1', port, supabaseUserId: member.supabaseUserId }
}

async function triggerRecovery(c: Context, target: Target, path: string): Promise<boolean> {
  if (target.supabaseUserId) {
    const member = getMember(c)
    if (!member) return false
    invalidateSupervisorCache(target.supabaseUserId)
    try {
      await ensureMemberDaemon(member)
      return true
    } catch (err) {
      console.error(
        `[Kortix Master] supervisor recovery failed for ${member.supabaseUserId}: ${err instanceof Error ? err.message : err}`,
      )
      return false
    }
  }
  const result = await serviceManager.requestRecovery(
    'opencode-serve',
    `proxy-connect:${path}`,
  )
  return !!result?.ok
}

export async function proxyToOpenCode(c: Context): Promise<Response> {
  const url = new URL(c.req.url)
  const target = await resolveTarget(c)
  const targetUrl = `http://${target.host}:${target.port}${url.pathname}${url.search}`
  const requestBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    ? await c.req.raw.arrayBuffer()
    : undefined

  // Build headers, forwarding most but not Host
  const headers = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (key.toLowerCase() !== 'host') {
      headers.set(key, value)
    }
  }

  // Detect if this is likely an SSE request (Accept: text/event-stream)
  const acceptsSSE = (c.req.header('accept') || '').includes('text/event-stream')

  async function fetchUpstream(): Promise<Response> {
    // For SSE: use an AbortController linked to the client request's signal
    // so when the client disconnects, we abort the upstream fetch too.
    // For regular requests: use a 30s timeout.
    const controller = new AbortController()
    const { signal } = controller

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
      // Regular request: 30s timeout
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
    }

    return fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: requestBody ? requestBody.slice(0) : undefined,
      // @ts-ignore - Bun supports duplex
      duplex: 'half',
      signal,
    })
  }

  try {
    const response = await fetchUpstream()

    // Check if this is an SSE/streaming response — pass body as stream
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/event-stream') || contentType.includes('application/octet-stream')) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
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
      headers: response.headers,
    })
  } catch (error) {
    // Handle abort/timeout errors cleanly (Bun throws TimeoutError for AbortSignal.timeout,
    // AbortError for manual controller.abort())
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      if (!acceptsSSE) {
        const healthy = await isOpenCodeHealthy(target.host, target.port)
        if (!healthy && recover(url.pathname)) {
          void triggerRecovery(c, target, url.pathname)
        }
        note(
          `timeout:${c.req.method}:${url.pathname}`,
          `[Kortix Master] OpenCode timeout on ${c.req.method} ${url.pathname} after ${FETCH_TIMEOUT_MS / 1000}s`,
        )
        return c.json({ error: 'OpenCode not responding', details: `${url.pathname} timed out after ${FETCH_TIMEOUT_MS / 1000}s — OpenCode may still be starting` }, 504)
      }
      // SSE client disconnected — just return empty response (connection is already gone)
      return new Response(null, { status: 499 })
    }
    const errMsg = error instanceof Error ? error.message : String(error)
    const isConnRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('Unable to connect')
    if (isConnRefused) {
      note(
        `unreachable:${c.req.method}:${url.pathname}`,
        `[Kortix Master] OpenCode unreachable on ${c.req.method} ${url.pathname}: ${errMsg} — is OpenCode running on ${target.host}:${target.port}?`,
      )
      const recovered = recover(url.pathname)
        ? await triggerRecovery(c, target, url.pathname)
        : false
      if (recovered) {
        try {
          const retryResponse = await fetchUpstream()
          const retryContentType = retryResponse.headers.get('content-type') || ''
          if (retryContentType.includes('text/event-stream') || retryContentType.includes('application/octet-stream')) {
            return new Response(retryResponse.body, {
              status: retryResponse.status,
              statusText: retryResponse.statusText,
              headers: retryResponse.headers,
            })
          }

          const retryBody = await retryResponse.arrayBuffer()
          return new Response(retryBody, {
            status: retryResponse.status,
            statusText: retryResponse.statusText,
            headers: retryResponse.headers,
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
