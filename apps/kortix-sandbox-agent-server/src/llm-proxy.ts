import { applyInlineImageWindow, imageWindowFromEnv, isChatRequestPath } from './llm-image-window'
import { logger } from './logger'

// ─────────────────────────────────────────────────────────────────────────────
// Localhost credential-injecting reverse proxy (the warm-fork "no restart on
// restore" mechanism). Two instances run when KORTIX_LLM_HOTSWAP=1:
//   • the LLM gateway proxy   (opencode's kortix provider baseURL → here)
//   • the connector MCP proxy  (kortix-connectors MCP's KORTIX_API_URL → here)
//
// WHY: a stateful warm-fork session attach used to KILL + respawn
// opencode purely to swap in the per-session tokens (LLM gateway key + connector
// token) — re-paying ~8s of opencode init that the snapshot already baked.
// opencode reads its config (provider.options.apiKey, mcp.environment) only at
// spawn, so swapping a token forced a config rebuild + restart.
//
// Fix: make those credentials SESSION-INDEPENDENT in the baked config. The config
// points the relevant baseURL/api-url at THIS localhost proxy with a fixed
// placeholder Bearer; the proxy holds the real per-session token in memory and
// rewrites the Authorization header on the way upstream. On restore the daemon just
// calls setToken() — opencode is never restarted.
//
// SCOPE: stateful warm-fork only (the caller gates it). Cold templates + Daytona
// never start these proxies and keep their direct config unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For a POST to a model endpoint with a JSON body: read it, apply the inline
 * image window, and return the re-serialized body — or null to stream the
 * request through untouched (not a model request, no window configured, not
 * JSON, or a body this cannot parse: the upstream then answers as it would
 * have anyway).
 */
async function windowModelRequestBody(req: Request, pathname: string, name: string): Promise<string | null> {
  if (req.method !== 'POST' || !isChatRequestPath(pathname)) return null
  const window = imageWindowFromEnv()
  if (!window) return null
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null
  let text: string
  try {
    text = await req.text()
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text
  const result = applyInlineImageWindow(parsed as Record<string, unknown>, window)
  if (result.dropped === 0) return text
  const out = JSON.stringify(parsed)
  logger.info(`[${name}-proxy] image window: kept ${result.total - result.dropped} of ${result.total} inline images`, {
    bytesBefore: Buffer.byteLength(text),
    bytesAfter: Buffer.byteLength(out),
  })
  return out
}

type ProxyState = {
  /** The real upstream base, e.g. https://gateway-dev.kortix.com/v1/llm (LLM) or
   *  the real KORTIX_API_URL (connector). */
  upstreamBase: string | null
  /** The live per-session bearer token sent upstream. */
  token: string | null
}

/** Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1) + host/auth/len
 *  which we set ourselves. Lower-cased for case-insensitive matching. */
const STRIP_REQ_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

export type CredentialProxy = {
  /** Start on a fixed port (idempotent). Best-effort: bind failure → null (caller
   *  falls back to the direct-config + restart path). Returns the localhost URL. */
  start(port: number, upstreamBase?: string, token?: string): string | null
  /** Update the live token (+ optional upstream). Instant, NO opencode restart. */
  setToken(token: string | undefined, upstreamBase?: string | undefined): void
  /** True once listening AND a usable upstream + token are set. */
  ready(): boolean
  /** The localhost URL the baked config should point at (stable across forks). */
  baseUrl(): string | null
  /** Stop (tests / shutdown). */
  stop(): void
  /** The non-secret placeholder Bearer baked into the config. */
  readonly placeholderKey: string
}

function createCredentialProxy(name: string, placeholderKey: string): CredentialProxy {
  const state: ProxyState = { upstreamBase: null, token: null }
  let server: ReturnType<typeof Bun.serve> | null = null
  let boundPort = 0

  function setToken(token: string | undefined, upstreamBase?: string | undefined): void {
    if (typeof token === 'string' && token.length > 0) state.token = token
    if (typeof upstreamBase === 'string' && upstreamBase.length > 0) {
      state.upstreamBase = upstreamBase.replace(/\/+$/, '')
    }
  }

  function ready(): boolean {
    return !!server && !!state.upstreamBase && !!state.token
  }

  function baseUrl(): string | null {
    return server ? `http://127.0.0.1:${boundPort}` : null
  }

  function start(port: number, upstreamBase?: string, token?: string): string | null {
    setToken(token, upstreamBase)
    if (server) return baseUrl()
    try {
      server = Bun.serve({
        port,
        hostname: '127.0.0.1',
        // Model streams can run minutes. 0 = no idle timeout.
        idleTimeout: 0,
        // Bun's default body ceiling is 128 MiB. A vision-heavy turn can be
        // larger than that BEFORE the window below shrinks it (Essentia
        // 2026-08-25: 118 inline screenshots); the whole point of windowing
        // here is that such a body never reaches the network, so accept it.
        maxRequestBodySize: 2 * 1024 * 1024 * 1024,
        async fetch(req) {
          const upstream = state.upstreamBase
          const tok = state.token
          if (!upstream || !tok) {
            // Not restored yet (or token cleared) — fail closed; never an open relay.
            return new Response(JSON.stringify({ error: `${name} proxy not ready` }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          }
          const inUrl = new URL(req.url)
          const target = `${upstream}${inUrl.pathname}${inUrl.search}`

          const headers = new Headers()
          req.headers.forEach((v, k) => {
            if (!STRIP_REQ_HEADERS.has(k.toLowerCase())) headers.set(k, v)
          })
          headers.set('authorization', `Bearer ${tok}`)

          try {
            // Model requests are windowed HERE, before they leave the sandbox
            // (see llm-image-window.ts). Everything else streams through.
            let body: RequestInit['body'] = req.body ?? undefined
            const windowed = await windowModelRequestBody(req, inUrl.pathname, name)
            if (windowed !== null) {
              body = windowed
              headers.set('content-length', String(Buffer.byteLength(windowed)))
            }
            // duplex:'half' is required by Bun/undici when a request carries a
            // streaming body; valid at runtime even where the RequestInit type
            // omits it, so build + cast rather than inline.
            const init: RequestInit & { duplex?: 'half' } = {
              method: req.method,
              headers,
              body,
              redirect: 'manual',
            }
            if (windowed === null && req.body) init.duplex = 'half'
            const upstreamRes = await fetch(target, init)
            const outHeaders = new Headers()
            upstreamRes.headers.forEach((v, k) => {
              const lk = k.toLowerCase()
              if (lk === 'transfer-encoding' || lk === 'connection') return
              outHeaders.set(k, v)
            })
            return new Response(upstreamRes.body, {
              status: upstreamRes.status,
              statusText: upstreamRes.statusText,
              headers: outHeaders,
            })
          } catch (err) {
            logger.warn(`[${name}-proxy] upstream error`, { target, err: (err as Error).message })
            return new Response(JSON.stringify({ error: `${name} proxy upstream error` }), {
              status: 502,
              headers: { 'content-type': 'application/json' },
            })
          }
        },
      })
      boundPort = server.port ?? port
      logger.info(`[${name}-proxy] listening`, { port: boundPort, hasUpstream: !!state.upstreamBase })
      return baseUrl()
    } catch (err) {
      logger.warn(`[${name}-proxy] failed to start; warm hot-swap disabled, falling back to restart path`, {
        err: (err as Error).message,
      })
      server = null
      return null
    }
  }

  function stop(): void {
    try {
      server?.stop(true)
    } catch {}
    server = null
    boundPort = 0
  }

  return { start, setToken, ready, baseUrl, stop, placeholderKey }
}

// ── instances ────────────────────────────────────────────────────────────────
const llm = createCredentialProxy('llm', 'kortix-llm-proxy-injected')
const connector = createCredentialProxy('connector', 'kortix-connectors-proxy-injected')

// LLM gateway proxy.
export const LLM_PROXY_PLACEHOLDER_KEY = llm.placeholderKey
export const startLlmProxy = (port: number, upstreamBase?: string, token?: string) =>
  llm.start(port, upstreamBase, token)
export const setLlmProxyToken = (token: string | undefined, upstreamBase?: string | undefined) =>
  llm.setToken(token, upstreamBase)
export const llmProxyReady = () => llm.ready()
export const llmProxyBaseUrl = () => llm.baseUrl()
export const stopLlmProxy = () => llm.stop()

// Connector MCP proxy.
export const CONNECTOR_PROXY_PLACEHOLDER_KEY = connector.placeholderKey
export const startConnectorProxy = (port: number, upstreamBase?: string, token?: string) =>
  connector.start(port, upstreamBase, token)
export const setConnectorProxyToken = (token: string | undefined, upstreamBase?: string | undefined) =>
  connector.setToken(token, upstreamBase)
export const connectorProxyReady = () => connector.ready()
export const connectorProxyBaseUrl = () => connector.baseUrl()
export const stopConnectorProxy = () => connector.stop()
