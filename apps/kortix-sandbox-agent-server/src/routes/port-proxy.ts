/**
 * Dynamic port proxy — /proxy/:port/*
 *
 * Pure dumb pipe: proxies requests to localhost:{port} inside the sandbox.
 * Uses decompress: false for true 1:1 byte passthrough.
 * Only touches: Host header, Location header (redirect rewriting).
 *
 * Resilience features:
 *   - Retry on transient errors (ECONNRESET, EPIPE) — handles mid-connection drops
 *   - Client disconnect propagation for SSE/streaming via AbortController
 *   - Proper error categorisation (transient vs refused vs timeout)
 *
 * Ported from main's `core/kortix-master/src/routes/proxy.ts` (the legacy
 * "Kortix Master" daemon). Strips the `hono-openapi` doc decorators since
 * this server doesn't expose an OpenAPI surface.
 */

import { Hono } from 'hono'
import {
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  isTransientError,
  isConnectionRefused,
  buildUpstreamHeaders,
  readBodyOnce,
  createClientAbort,
  detectSSE,
  getFetchSignal,
} from './proxy-utils'

const EXTRA_STRIP = new Set(['authorization'])

export function createPortProxyRouter(opts: { blockedPorts: ReadonlySet<number> }): Hono {
  const portProxyRouter = new Hono()

  portProxyRouter.all('/:port{[0-9]+}/*', async (c) => {
    const portStr = c.req.param('port')
    const port = parseInt(portStr, 10)

    if (isNaN(port) || port < 1 || port > 65535) {
      return c.json({ error: 'Invalid port number', port: portStr }, 400)
    }
    if (opts.blockedPorts.has(port)) {
      return c.json({ error: 'Port is blocked', port }, 403)
    }

    const url = new URL(c.req.url)
    const prefix = `/proxy/${portStr}`
    const remainingPath = url.pathname.slice(prefix.length) || '/'
    const targetUrl = `http://localhost:${port}${remainingPath}${url.search}`

    const headers = buildUpstreamHeaders(c, EXTRA_STRIP)
    headers.set('Host', `localhost:${port}`)

    const acceptsSSE = detectSSE(c)

    let body: ArrayBuffer | undefined
    try {
      body = await readBodyOnce(c)
    } catch {
      return c.json({ error: 'Failed to read request body' }, 400)
    }

    const clientAbort = createClientAbort(c)

    let lastError = ''

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (clientAbort.signal.aborted) {
        return new Response(null, { status: 499 })
      }

      try {
        const signal = getFetchSignal(acceptsSSE, clientAbort)

        const response = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          body,
          // @ts-ignore — Bun extension: pass raw bytes, no decompression
          decompress: false,
          redirect: 'manual',
          signal,
        })

        const responseHeaders = new Headers(response.headers)

        const location = responseHeaders.get('location')
        if (location) {
          try {
            const locUrl = new URL(location, `http://localhost:${port}`)
            if (locUrl.hostname === 'localhost' && parseInt(locUrl.port || '80') === port) {
              responseHeaders.set('location', `${prefix}${locUrl.pathname}${locUrl.search}`)
            }
          } catch { /* leave as-is */ }
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        lastError = errMsg

        if (clientAbort.signal.aborted) {
          return new Response(null, { status: 499 })
        }

        if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          console.error(`[proxy] Timeout on ${c.req.method} /proxy/${port}${remainingPath} after ${FETCH_TIMEOUT_MS / 1000}s`)
          return c.json({ error: 'Upstream request timed out', port }, 504)
        }

        if (isConnectionRefused(errMsg)) {
          // HEAD / and POST /v1/p/auth are the frontend's port health checks —
          // don't spam logs for dead ports.
          const isProbe = c.req.method === 'HEAD' || remainingPath === '/v1/p/auth'
          if (!isProbe) {
            console.error(
              `[proxy] Port ${port} unreachable on ${c.req.method} ${remainingPath}: nothing is listening on localhost:${port}`,
            )
          }
          return c.json({
            error: 'Failed to connect to service',
            port,
            hint: `Nothing listening on localhost:${port}`,
            details: 'Unable to connect. Is the computer able to access the url?',
          }, 502)
        }

        if (isTransientError(errMsg) && attempt < MAX_RETRIES) {
          console.warn(
            `[proxy] Transient error on attempt ${attempt + 1}/${MAX_RETRIES + 1} ` +
            `for port ${port}: ${errMsg}, retrying in ${RETRY_DELAY_MS * (attempt + 1)}ms...`,
          )
          await Bun.sleep(RETRY_DELAY_MS * (attempt + 1))
          continue
        }

        console.error(`[proxy] Error on ${c.req.method} /proxy/${port}${remainingPath}: ${errMsg}`)
      }
    }

    return c.json({
      error: 'Failed to connect to service',
      port,
      details: lastError,
    }, 502)
  })

  portProxyRouter.all('/:port{[0-9]+}', async (c) => {
    const portStr = c.req.param('port')
    const url = new URL(c.req.url)
    return c.redirect(`/proxy/${portStr}/${url.search}`, 301)
  })

  return portProxyRouter
}
