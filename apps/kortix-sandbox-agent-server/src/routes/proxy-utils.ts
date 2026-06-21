import type { Context } from 'hono'

export const FETCH_TIMEOUT_MS = 30_000
export const MAX_RETRIES = 2
export const RETRY_DELAY_MS = 300

const TRANSIENT_ERROR_PATTERNS = [
  'ECONNRESET', 'EPIPE', 'ECONNABORTED',
  'ERR_STREAM_DESTROYED', 'socket hang up',
]

export function isTransientError(errMsg: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some(p => errMsg.includes(p))
}

export function isConnectionRefused(errMsg: string): boolean {
  return (
    errMsg.includes('ECONNREFUSED') ||
    errMsg.includes('Unable to connect') ||
    errMsg.includes('Connection refused')
  )
}

const STRIP_REQUEST_HEADERS_BASE = new Set([
  'host',
  'service-worker',
  'connection',
  'keep-alive',
  'te',
  'upgrade',
])

export function buildUpstreamHeaders(c: Context, extraStrip?: Set<string>): Headers {
  const headers = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    const lower = key.toLowerCase()
    if (STRIP_REQUEST_HEADERS_BASE.has(lower)) continue
    if (extraStrip?.has(lower)) continue
    headers.set(key, value)
  }
  return headers
}

export async function readBodyOnce(c: Context): Promise<ArrayBuffer | undefined> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined
  return c.req.raw.arrayBuffer()
}

export function createClientAbort(c: Context): AbortController {
  const controller = new AbortController()
  const clientSignal = c.req.raw.signal
  if (clientSignal) {
    if (clientSignal.aborted) {
      controller.abort()
    } else {
      clientSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }
  return controller
}

export function detectSSE(c: Context): boolean {
  return (c.req.header('accept') || '').includes('text/event-stream')
}

export function getFetchSignal(isSSE: boolean, clientAbort: AbortController): AbortSignal {
  return isSSE ? clientAbort.signal : AbortSignal.timeout(FETCH_TIMEOUT_MS)
}
