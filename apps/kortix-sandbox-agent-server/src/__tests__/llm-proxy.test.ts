import { describe, test, expect, afterEach } from 'bun:test'
import {
  startLlmProxy,
  setLlmProxyToken,
  llmProxyReady,
  llmProxyBaseUrl,
  stopLlmProxy,
  LLM_PROXY_PLACEHOLDER_KEY,
  startConnectorProxy,
  setConnectorProxyToken,
  connectorProxyReady,
  connectorProxyBaseUrl,
  stopConnectorProxy,
} from '../llm-proxy'

// A mock upstream that echoes back the Authorization header + path it received,
// so we can prove the proxy injects the live token (not the placeholder).
function mockUpstream() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      return new Response(
        JSON.stringify({ auth: req.headers.get('authorization'), path: u.pathname + u.search, acceptEncoding: req.headers.get('accept-encoding') }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

// Typed read of the mock's echo body — global fetch().json() is `unknown` under
// strict tsc, which the daemon CI's `tsc --noEmit` (not just `bun test`) enforces.
async function fetchJson(url: string): Promise<{ auth: string | null; path: string; acceptEncoding: string | null }> {
  const res = await fetch(url)
  return (await res.json()) as { auth: string | null; path: string; acceptEncoding: string | null }
}

describe('credential proxy — live token swap (the no-restart mechanism)', () => {
  afterEach(() => {
    stopLlmProxy()
    stopConnectorProxy()
  })

  test('fails closed (503) before any token is set — never an open relay', async () => {
    const up = mockUpstream()
    try {
      // fresh proxy, never tokened (the pre-restore window) → must fail closed
      startLlmProxy(14319, up.url)
      expect(llmProxyReady()).toBe(false)
      const res = await fetch(`${llmProxyBaseUrl()}/v1/llm/models`)
      expect(res.status).toBe(503)
    } finally {
      up.stop()
    }
  })

  test('LLM proxy injects the live token and SWAPS it without a restart', async () => {
    const up = mockUpstream()
    try {
      startLlmProxy(14319, up.url, 'token-A')
      const base = llmProxyBaseUrl()
      expect(base).toBe('http://127.0.0.1:14319')
      expect(llmProxyReady()).toBe(true)

      // request 1 → upstream sees token-A, path preserved
      const r1 = await fetchJson(`${base}/v1/llm/models`)
      expect(r1.auth).toBe('Bearer token-A')
      expect(r1.path).toBe('/v1/llm/models')
      expect(r1.acceptEncoding).toBe('identity')

      // swap the token LIVE — same proxy process, no restart
      setLlmProxyToken('token-B')
      const r2 = await fetchJson(`${base}/v1/llm/chat/completions`)
      expect(r2.auth).toBe('Bearer token-B')
      expect(r2.path).toBe('/v1/llm/chat/completions')
    } finally {
      up.stop()
    }
  })

  test('returns decompressed upstream content without stale compression headers', async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: 'TURN_OK' } }] })
    const compressed = Bun.gzipSync(payload)
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(compressed, { headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.byteLength),
      } }),
    })
    try {
      startLlmProxy(14319, `http://127.0.0.1:${upstream.port}`, 'token')
      const response = await fetch(`${llmProxyBaseUrl()}/chat/completions`)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(await response.text()).toBe(payload)
    } finally {
      upstream.stop(true)
    }
  })

  test('the connector and LLM proxies hold separate tokens: a swap on one leaves the other', async () => {
    const up = mockUpstream()
    try {
      startLlmProxy(14319, up.url, 'llm-A')
      startConnectorProxy(14320, up.url, 'exec-A')
      expect(connectorProxyBaseUrl()).toBe('http://127.0.0.1:14320')
      expect(connectorProxyReady()).toBe(true)
      expect((await fetchJson(`${connectorProxyBaseUrl()}/v1/projects/p/exec`)).auth).toBe('Bearer exec-A')

      setConnectorProxyToken('exec-B')
      expect((await fetchJson(`${connectorProxyBaseUrl()}/v1/projects/p/exec`)).auth).toBe('Bearer exec-B')
      expect((await fetchJson(`${llmProxyBaseUrl()}/v1/llm/models`)).auth).toBe('Bearer llm-A')

      setLlmProxyToken('llm-B')
      expect((await fetchJson(`${connectorProxyBaseUrl()}/v1/projects/p/exec`)).auth).toBe('Bearer exec-B')
    } finally {
      up.stop()
    }
  })

})

describe('in-sandbox inline image window (SampleCo 2026-08-25: >128 MiB vision bodies 413d at the edge)', () => {
  afterEach(() => {
    stopLlmProxy()
    delete process.env.KORTIX_LLM_MAX_INLINE_IMAGES
  })

  function countingUpstream() {
    let seen: { images: number; bytes: number; contentLength: string | null; auth: string | null } | null = null
    const server = Bun.serve({
      port: 0,
      maxRequestBodySize: 512 * 1024 * 1024,
      async fetch(req) {
        const text = await req.text()
        const body = JSON.parse(text) as { messages: Array<{ content: Array<{ type: string }> }> }
        const images = body.messages.flatMap((m) => m.content).filter((p) => p.type === 'image_url').length
        seen = { images, bytes: text.length, contentLength: req.headers.get('content-length'), auth: req.headers.get('authorization') }
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), seen: () => seen }
  }

  const img = (n: number) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(64 * 1024)}${n}` } })

  test('a model request over the window leaves the sandbox with only the most recent images', async () => {
    const up = countingUpstream()
    try {
      startLlmProxy(14321, up.url, 'real-token')
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'a' }, ...Array.from({ length: 15 }, (_, i) => img(i))] },
        { role: 'user', content: [{ type: 'text', text: 'b' }, ...Array.from({ length: 15 }, (_, i) => img(15 + i))] },
      ]
      const res = await fetch(`${llmProxyBaseUrl()}/v1/llm/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_PROXY_PLACEHOLDER_KEY}` },
        body: JSON.stringify({ model: 'x', messages }),
      })
      expect(res.status).toBe(200)
      const seen = up.seen()!
      expect(seen.images).toBe(12) // DEFAULT_IMAGE_WINDOW.keepOnOverflow
      expect(seen.auth).toBe('Bearer real-token')
      expect(Number(seen.contentLength)).toBe(seen.bytes)
      expect(seen.bytes).toBeLessThan(15 * 64 * 1024)
    } finally {
      up.stop()
    }
  })

  test('a request under the window and a non-model path stream through untouched', async () => {
    const up = countingUpstream()
    try {
      startLlmProxy(14322, up.url, 'real-token')
      const messages = [{ role: 'user', content: [{ type: 'text', text: 'a' }, img(1), img(2)] }]
      const res = await fetch(`${llmProxyBaseUrl()}/v1/llm/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages }),
      })
      expect(res.status).toBe(200)
      expect(up.seen()!.images).toBe(2)

      // Only chat-shaped paths are windowed: 25 images to another path all pass.
      const many = [{ role: 'user', content: Array.from({ length: 25 }, (_, i) => img(i)) }]
      const other = await fetch(`${llmProxyBaseUrl()}/v1/llm/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: many }),
      })
      expect(other.status).toBe(200)
      expect(up.seen()!.images).toBe(25)
    } finally {
      up.stop()
    }
  })

  test('KORTIX_LLM_MAX_INLINE_IMAGES=0 disables the window', async () => {
    process.env.KORTIX_LLM_MAX_INLINE_IMAGES = '0'
    const up = countingUpstream()
    try {
      startLlmProxy(14323, up.url, 'real-token')
      const messages = [{ role: 'user', content: Array.from({ length: 25 }, (_, i) => img(i)) }]
      await fetch(`${llmProxyBaseUrl()}/v1/llm/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages }),
      })
      expect(up.seen()!.images).toBe(25)
    } finally {
      up.stop()
    }
  })
})
