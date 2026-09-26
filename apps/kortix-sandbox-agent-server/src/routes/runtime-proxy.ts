import { Hono } from 'hono'
import type { Config } from '../config'
import type { SandboxBootState } from '../boot-state'
import type { HarnessProxyService } from '../harness/proxy'
import { withSseKeepalive } from '../sse-keepalive'

// Connection-scoped headers are a transport concern, not harness behavior.
const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding'])
const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection'])

/** Auth runs in the host before this compatibility catch-all. */
export function createRuntimeProxyRouter(
  context: { cfg: Config; bootState: SandboxBootState },
  runtime: HarnessProxyService,
): Hono {
  const app = new Hono()
  app.all('*', async (c) => {
    const readiness = await runtime.readiness(context)
    if (!readiness.ready) {
      c.header('X-Kortix-Boot-Phase', readiness.phase)
      return c.json({ ...readiness.details, phase: readiness.phase }, 503)
    }

    const url = new URL(c.req.url)
    const headers = new Headers()
    c.req.raw.headers.forEach((value, key) => {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
    })
    try {
      const upstream = await runtime.forward({
        method: c.req.method,
        path: url.pathname,
        search: url.search,
        headers,
        body: c.req.raw.body,
      })
      const respHeaders = new Headers()
      upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value)
      })

      // Keepalive framing belongs to delivery. Native event bytes stay intact.
      const upstreamContentType = upstream.headers.get('content-type') ?? ''
      if (upstream.status >= 200 && upstream.status < 300 && upstream.body instanceof ReadableStream
          && upstreamContentType.includes('text/event-stream')) {
        respHeaders.delete('content-length')
        return new Response(withSseKeepalive(upstream.body), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: respHeaders,
        })
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      })
    } catch (err) {
      return c.json({ error: 'upstream unreachable', details: (err as Error).message }, 502)
    }
  })
  return app
}
