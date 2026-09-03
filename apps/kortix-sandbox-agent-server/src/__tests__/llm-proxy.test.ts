import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  CONNECTOR_PROXY_PLACEHOLDER_KEY,
} from '../llm-proxy'
import { buildOpencodeConfigContent, refreshGatewayCatalogFile } from '../opencode'

// A mock upstream that echoes back the Authorization header + path it received,
// so we can prove the proxy injects the live token (not the placeholder).
function mockUpstream() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      return new Response(
        JSON.stringify({ auth: req.headers.get('authorization'), path: u.pathname + u.search }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

// Typed read of the mock's echo body — global fetch().json() is `unknown` under
// strict tsc, which the daemon CI's `tsc --noEmit` (not just `bun test`) enforces.
async function fetchJson(url: string): Promise<{ auth: string | null; path: string }> {
  const res = await fetch(url)
  return (await res.json()) as { auth: string | null; path: string }
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

      // swap the token LIVE — same proxy process, no restart
      setLlmProxyToken('token-B')
      const r2 = await fetchJson(`${base}/v1/llm/chat/completions`)
      expect(r2.auth).toBe('Bearer token-B')
      expect(r2.path).toBe('/v1/llm/chat/completions')
    } finally {
      up.stop()
    }
  })

  test('connector proxy injects + swaps its token independently', async () => {
    const up = mockUpstream()
    try {
      startConnectorProxy(14320, up.url, 'exec-A')
      const base = connectorProxyBaseUrl()
      expect(base).toBe('http://127.0.0.1:14320')
      expect(connectorProxyReady()).toBe(true)

      const r1 = await fetchJson(`${base}/v1/projects/p/exec`)
      expect(r1.auth).toBe('Bearer exec-A')

      setConnectorProxyToken('exec-B')
      const r2 = await fetchJson(`${base}/v1/projects/p/exec`)
      expect(r2.auth).toBe('Bearer exec-B')
    } finally {
      up.stop()
    }
  })

})

describe('buildOpencodeConfigContent — proxy mode vs direct mode', () => {
  const catalog = join(mkdtempSync(join(tmpdir(), 'cat-')), 'catalog.json')
  writeFileSync(
    catalog,
    JSON.stringify({ models: { 'kortix/test-model': { id: 'kortix/test-model', name: 'Test' } } }),
  )

  test('PROXY mode: session-independent provider by default, no connector MCP unless enabled', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_CONNECTORS_PROXY_URL: 'http://127.0.0.1:4320',
      KORTIX_API_URL: 'https://api.kortix.test/v1',
      KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
      KORTIX_TOKEN: 'real-session-token',
      KORTIX_LLM_CATALOG_FILE: catalog,
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)

    // gateway provider points at the proxy with a placeholder — NO real key baked
    expect(cfg.provider.kortix.options.baseURL).toBe('http://127.0.0.1:4319')
    expect(cfg.provider.kortix.options.apiKey).toBe(LLM_PROXY_PLACEHOLDER_KEY)
    expect(cfg.provider.kortix.options.apiKey).not.toBe('real-session-llm-key')

    // Connector MCP is an optional compatibility face. The CLI is primary.
    expect(cfg.mcp).toBeUndefined()

    // full catalog came from the baked file
    expect(Object.keys(cfg.provider.kortix.models)).toContain('kortix/test-model')
  })

  test('PROXY mode can opt into session-independent connector MCP compatibility', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_CONNECTORS_PROXY_URL: 'http://127.0.0.1:4320',
      KORTIX_API_URL: 'https://api.kortix.test/v1',
      KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
      KORTIX_TOKEN: 'real-session-token',
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      KORTIX_LLM_CATALOG_FILE: catalog,
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)

    expect(cfg.mcp['kortix-connectors'].command).toEqual(['/usr/local/bin/kortix', 'connectors', 'mcp'])
    expect(cfg.mcp['kortix-connectors'].environment.KORTIX_API_URL).toBe('http://127.0.0.1:4320')
    expect(cfg.mcp['kortix-connectors'].environment.KORTIX_TOKEN).toBe(CONNECTOR_PROXY_PLACEHOLDER_KEY)
    expect(cfg.mcp['kortix-connectors'].environment.KORTIX_TOKEN).not.toBe('real-session-exec-token')
  })

  test('DIRECT mode (cold/Daytona): real key + token baked, unchanged', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_API_URL: 'https://api.kortix.test/v1',
      KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
      KORTIX_TOKEN: 'real-session-token',
      KORTIX_LLM_CATALOG_FILE: catalog,
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)
    expect(cfg.provider.kortix.options.baseURL).toBe('https://gateway.kortix.test/v1/llm')
    expect(cfg.provider.kortix.options.apiKey).toBe('real-session-token')
    expect(cfg.mcp).toBeUndefined()
  })
})

describe('refreshGatewayCatalogFile — warm snapshot catalog recovery', () => {
  test('replaces a stale frozen catalog with the authenticated live catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'))
    const frozen = join(dir, 'frozen.json')
    const refreshed = join(dir, 'refreshed.json')
    writeFileSync(frozen, JSON.stringify({ models: { 'retired-model': { name: 'Retired' } } }))

    const liveModels = {
      'glm-5.3-flash': { name: 'GLM 5.3 Flash' },
      'claude-sonnet-4.6': { name: 'Claude Sonnet 4.6' },
    }
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        expect(req.headers.get('authorization')).toBe('Bearer live-session-token')
        return Response.json({ models: liveModels })
      },
    })

    try {
      const result = await refreshGatewayCatalogFile({
        currentCatalogFile: frozen,
        targetCatalogFile: refreshed,
        fetchBaseURL: `http://127.0.0.1:${server.port}`,
        fetchApiKey: 'live-session-token',
      })

      expect(result).toEqual({ changed: true, catalogFile: refreshed })
      expect(JSON.parse(readFileSync(refreshed, 'utf8'))).toEqual({ models: liveModels })
    } finally {
      server.stop(true)
    }
  })

  test('keeps the no-restart path when the frozen and live catalogs match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-current-'))
    const frozen = join(dir, 'frozen.json')
    const refreshed = join(dir, 'refreshed.json')
    const liveModels = { 'glm-5.3-flash': { name: 'GLM 5.3 Flash' } }
    writeFileSync(frozen, JSON.stringify({ models: liveModels }))

    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ models: liveModels }),
    })

    try {
      const result = await refreshGatewayCatalogFile({
        currentCatalogFile: frozen,
        targetCatalogFile: refreshed,
        fetchBaseURL: `http://127.0.0.1:${server.port}`,
        fetchApiKey: 'live-session-token',
      })

      expect(result).toEqual({ changed: false, catalogFile: refreshed })
      expect(JSON.parse(readFileSync(refreshed, 'utf8'))).toEqual({ models: liveModels })
    } finally {
      server.stop(true)
    }
  })
})

describe('in-sandbox inline image window (Essentia 2026-08-25: >128 MiB vision bodies 413d at the edge)', () => {
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
