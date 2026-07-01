import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  startLlmProxy,
  setLlmProxyToken,
  llmProxyReady,
  llmProxyBaseUrl,
  stopLlmProxy,
  LLM_PROXY_PLACEHOLDER_KEY,
  startExecutorProxy,
  setExecutorProxyToken,
  executorProxyReady,
  executorProxyBaseUrl,
  stopExecutorProxy,
  EXECUTOR_PROXY_PLACEHOLDER_KEY,
  shouldDisableProxyModeGateway,
} from '../llm-proxy'
import { buildOpencodeConfigContent } from '../opencode'

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
    stopExecutorProxy()
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

  test('executor proxy injects + swaps its token independently', async () => {
    const up = mockUpstream()
    try {
      startExecutorProxy(14320, up.url, 'exec-A')
      const base = executorProxyBaseUrl()
      expect(base).toBe('http://127.0.0.1:14320')
      expect(executorProxyReady()).toBe(true)

      const r1 = await fetchJson(`${base}/v1/projects/p/exec`)
      expect(r1.auth).toBe('Bearer exec-A')

      setExecutorProxyToken('exec-B')
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

  test('PROXY mode: session-independent provider by default, no executor MCP unless enabled', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_EXECUTOR_PROXY_URL: 'http://127.0.0.1:4320',
      KORTIX_API_URL: 'https://api.kortix.test/v1',
      KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
      KORTIX_LLM_API_KEY: 'real-session-llm-key',
      KORTIX_EXECUTOR_TOKEN: 'real-session-exec-token',
      KORTIX_LLM_CATALOG_FILE: catalog,
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)

    // gateway provider points at the proxy with a placeholder — NO real key baked
    expect(cfg.provider.kortix.options.baseURL).toBe('http://127.0.0.1:4319')
    expect(cfg.provider.kortix.options.apiKey).toBe(LLM_PROXY_PLACEHOLDER_KEY)
    expect(cfg.provider.kortix.options.apiKey).not.toBe('real-session-llm-key')

    // Executor MCP is an optional compatibility face. The CLI is primary.
    expect(cfg.mcp).toBeUndefined()

    // full catalog came from the baked file
    expect(Object.keys(cfg.provider.kortix.models)).toContain('kortix/test-model')
  })

  test('PROXY mode can opt into session-independent executor MCP compatibility', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_EXECUTOR_PROXY_URL: 'http://127.0.0.1:4320',
      KORTIX_API_URL: 'https://api.kortix.test/v1',
      KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
      KORTIX_LLM_API_KEY: 'real-session-llm-key',
      KORTIX_EXECUTOR_TOKEN: 'real-session-exec-token',
      KORTIX_EXECUTOR_MCP_ENABLED: '1',
      KORTIX_LLM_CATALOG_FILE: catalog,
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)

    expect(cfg.mcp['kortix-executor'].command).toEqual(['/usr/local/bin/kortix', 'executor', 'mcp'])
    expect(cfg.mcp['kortix-executor'].environment.KORTIX_API_URL).toBe('http://127.0.0.1:4320')
    expect(cfg.mcp['kortix-executor'].environment.KORTIX_EXECUTOR_TOKEN).toBe(EXECUTOR_PROXY_PLACEHOLDER_KEY)
    expect(cfg.mcp['kortix-executor'].environment.KORTIX_EXECUTOR_TOKEN).not.toBe('real-session-exec-token')
  })

  test('DIRECT mode (cold/Daytona): real key + token baked, unchanged', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_API_URL: 'https://api.kortix.test/v1',
      KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
      KORTIX_LLM_API_KEY: 'real-session-llm-key',
      KORTIX_EXECUTOR_TOKEN: 'real-session-exec-token',
      KORTIX_LLM_CATALOG_FILE: catalog,
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)
    expect(cfg.provider.kortix.options.baseURL).toBe('https://gateway.kortix.test/v1/llm')
    expect(cfg.provider.kortix.options.apiKey).toBe('real-session-llm-key')
    expect(cfg.mcp).toBeUndefined()
  })

  // The hazard the adoption fix compensates for: with proxy-mode baked but NO
  // per-session gateway token (unentitled account), the config STILL mounts the
  // kortix provider pointed at the proxy — so at runtime every call would hit the
  // token-less proxy and 503 "llm proxy not ready". Locking this makes the reason
  // the daemon must drop KORTIX_LLM_PROXY_URL for such sessions explicit.
  test('PROXY mode still mounts the kortix provider even with NO session token (the failure the fix guards)', async () => {
    const json = await buildOpencodeConfigContent({
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_LLM_CATALOG_FILE: catalog,
      // no KORTIX_LLM_API_KEY / KORTIX_LLM_BASE_URL — account not entitled
    } as NodeJS.ProcessEnv)
    expect(json).toBeDefined()
    const cfg = JSON.parse(json!)
    expect(cfg.provider.kortix.options.baseURL).toBe('http://127.0.0.1:4319')
    expect(cfg.provider.kortix.options.apiKey).toBe(LLM_PROXY_PLACEHOLDER_KEY)
    expect(cfg.enabled_providers).toEqual(['kortix'])
  })

  // What the adoption fix produces for an unentitled account: it deletes
  // KORTIX_LLM_PROXY_URL, so the rebuilt config has no gateway provider at all and
  // opencode falls back to its native catalog (matching Daytona) — no dead proxy.
  test('dropping the proxy URL with no session token yields native fallback (no kortix provider)', async () => {
    expect(await buildOpencodeConfigContent({ KORTIX_LLM_CATALOG_FILE: catalog } as NodeJS.ProcessEnv)).toBeUndefined()
  })
})

describe('shouldDisableProxyModeGateway — adoption decision', () => {
  test('tears proxy-mode down only when it is baked but the proxy holds no token', () => {
    // Unentitled account: seed baked proxy-mode, but no gateway token was injected
    // → drop proxy-mode so opencode falls back to native models.
    expect(shouldDisableProxyModeGateway({ hotswapBaked: true, proxyUrlSet: true, proxyReady: false })).toBe(true)
    // Entitled: the proxy holds a usable token → keep proxy-mode (even if the fast
    // hot-swap path was skipped for opencode-not-ok / repo-error reasons).
    expect(shouldDisableProxyModeGateway({ hotswapBaked: true, proxyUrlSet: true, proxyReady: true })).toBe(false)
    // Cold / Daytona: proxy-mode was never baked → nothing to tear down.
    expect(shouldDisableProxyModeGateway({ hotswapBaked: false, proxyUrlSet: false, proxyReady: false })).toBe(false)
    // Hot-swap flag on but the proxy never started (bind failure) → not our case.
    expect(shouldDisableProxyModeGateway({ hotswapBaked: true, proxyUrlSet: false, proxyReady: false })).toBe(false)
  })
})
