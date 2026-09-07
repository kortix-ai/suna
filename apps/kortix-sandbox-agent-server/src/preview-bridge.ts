import { createHmac, timingSafeEqual } from 'node:crypto'

export const PREVIEW_TARGET_HEADER = 'x-kortix-preview-target'
export const PREVIEW_PATH_PREFIX = '/__kortix_preview'

export type PreviewTargetResult =
  | { ok: true; port: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'ttl' | 'signature' }

export function verifyPreviewTarget(
  value: string,
  sandboxToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreviewTargetResult {
  const match = /^([1-9][0-9]{0,4})\.([1-9][0-9]*)\.([A-Za-z0-9_-]{43})$/.exec(value)
  if (!match) return { ok: false, reason: 'malformed' }
  const portText = match[1]!
  const expiryText = match[2]!
  const signatureText = match[3]!
  const port = Number(portText)
  const expiresAt = Number(expiryText)
  if (!Number.isSafeInteger(expiresAt) || port > 65535) return { ok: false, reason: 'malformed' }
  if (expiresAt <= nowSeconds) return { ok: false, reason: 'expired' }
  if (expiresAt > nowSeconds + 60) return { ok: false, reason: 'ttl' }

  const expected = createHmac('sha256', sandboxToken)
    .update(`localhost-preview:${portText}.${expiryText}`)
    .digest()
  const supplied = Buffer.from(signatureText, 'base64url')
  if (
    supplied.toString('base64url') !== signatureText ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { ok: false, reason: 'signature' }
  }
  return { ok: true, port }
}

const FIXED_STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'forwarded',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'proxy-authenticate',
  'x-daytona-preview-token',
  'x-daytona-skip-preview-warning',
  'x-daytona-disable-cors',
  'e2b-traffic-access-token',
])

export function buildPreviewUpstreamHeaders(source: Headers, port: number): Headers {
  const connectionFields = new Set(
    (source.get('connection') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  )
  const headers = new Headers()
  source.forEach((value, rawName) => {
    const name = rawName.toLowerCase()
    if (FIXED_STRIP_REQUEST_HEADERS.has(name) || connectionFields.has(name)) return
    if (name.startsWith('x-kortix-')) return
    if (name.startsWith('sec-websocket-')) return
    if (name.startsWith('x-forwarded-') && name !== 'x-forwarded-prefix') return
    if (name === 'origin' || name === 'referer') return
    headers.append(rawName, value)
  })
  const authority = `localhost:${port}`
  headers.set('host', authority)
  headers.set('x-forwarded-host', authority)
  headers.set('x-forwarded-proto', 'http')
  if (source.has('origin')) headers.set('origin', `http://${authority}`)
  const referer = source.get('referer')
  if (referer) {
    try {
      const parsed = new URL(referer)
      headers.set('referer', `http://${authority}${parsed.pathname}${parsed.search}`)
    } catch {
      headers.set('referer', `http://${authority}/`)
    }
  }
  return headers
}

function previewPath(url: URL): string | null {
  if (url.pathname === PREVIEW_PATH_PREFIX) return '/'
  if (!url.pathname.startsWith(`${PREVIEW_PATH_PREFIX}/`)) return null
  return url.pathname.slice(PREVIEW_PATH_PREFIX.length)
}

export function previewTargetPath(request: Request): string | null {
  return previewPath(new URL(request.url))
}

export function previewWebSocketUrl(request: Request, port: number): string | null {
  const incomingUrl = new URL(request.url)
  const path = previewPath(incomingUrl)
  return path === null ? null : `ws://localhost:${port}${path}${incomingUrl.search}`
}

export async function forwardPreviewHttp(request: Request, port: number): Promise<Response> {
  const incomingUrl = new URL(request.url)
  const path = previewPath(incomingUrl)
  if (path === null) return Response.json({ error: 'preview target requires preview path prefix' }, { status: 401 })
  const targetUrl = `http://localhost:${port}${path}${incomingUrl.search}`
  const upstreamAbort = new AbortController()
  const abortUpstream = () => upstreamAbort.abort(request.signal.reason)
  request.signal.addEventListener('abort', abortUpstream, { once: true })
  const connectTimeout = setTimeout(() => upstreamAbort.abort('preview upstream response timeout'), 10_000)
  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: buildPreviewUpstreamHeaders(request.headers, port),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: upstreamAbort.signal,
      duplex: 'half',
      decompress: false,
    })
    clearTimeout(connectTimeout)
    const headers = new Headers(response.headers)
    const connectionFields = new Set(
      (headers.get('connection') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
    )
    for (const name of [
      'connection', 'transfer-encoding', 'keep-alive', 'proxy-connection',
      'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
      ...connectionFields,
    ]) headers.delete(name)
    headers.set('x-kortix-preview-bridge', '1')
    const location = headers.get('location')
    if (location) {
      try {
        const parsed = new URL(location, targetUrl)
        if (parsed.hostname === 'localhost' && Number(parsed.port || 80) === port) {
          headers.set('location', `${parsed.pathname}${parsed.search}${parsed.hash}`)
        }
      } catch {}
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } catch (error) {
    clearTimeout(connectTimeout)
    request.signal.removeEventListener('abort', abortUpstream)
    return Response.json({
      error: 'preview target unreachable',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}
