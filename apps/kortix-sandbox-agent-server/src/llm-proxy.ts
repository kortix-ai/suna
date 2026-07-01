import { logger } from './logger'

// ─────────────────────────────────────────────────────────────────────────────
// Localhost credential-injecting reverse proxy (the warm-fork "no restart on
// restore" mechanism). Two instances run when KORTIX_LLM_HOTSWAP=1:
//   • the LLM gateway proxy   (opencode's kortix provider baseURL → here)
//   • the executor MCP proxy  (kortix-executor MCP's KORTIX_API_URL → here)
//
// WHY: a stateful warm-fork session attach used to KILL + respawn
// opencode purely to swap in the per-session tokens (LLM gateway key + executor
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

type ProxyState = {
  /** The real upstream base, e.g. https://gateway-dev.kortix.com/v1/llm (LLM) or
   *  the real KORTIX_API_URL (executor). */
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
            // duplex:'half' is required by Bun/undici when a request carries a
            // streaming body; valid at runtime even where the RequestInit type
            // omits it, so build + cast rather than inline.
            const init: RequestInit & { duplex?: 'half' } = {
              method: req.method,
              headers,
              body: req.body ?? undefined,
              redirect: 'manual',
            }
            if (req.body) init.duplex = 'half'
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
const executor = createCredentialProxy('executor', 'kortix-executor-proxy-injected')

// LLM gateway proxy.
export const LLM_PROXY_PLACEHOLDER_KEY = llm.placeholderKey
export const startLlmProxy = (port: number, upstreamBase?: string, token?: string) =>
  llm.start(port, upstreamBase, token)
export const setLlmProxyToken = (token: string | undefined, upstreamBase?: string | undefined) =>
  llm.setToken(token, upstreamBase)
export const llmProxyReady = () => llm.ready()
export const llmProxyBaseUrl = () => llm.baseUrl()
export const stopLlmProxy = () => llm.stop()

// Executor MCP proxy.
export const EXECUTOR_PROXY_PLACEHOLDER_KEY = executor.placeholderKey
export const startExecutorProxy = (port: number, upstreamBase?: string, token?: string) =>
  executor.start(port, upstreamBase, token)
export const setExecutorProxyToken = (token: string | undefined, upstreamBase?: string | undefined) =>
  executor.setToken(token, upstreamBase)
export const executorProxyReady = () => executor.ready()
export const executorProxyBaseUrl = () => executor.baseUrl()
export const stopExecutorProxy = () => executor.stop()

// ── Adoption-time decision ─────────────────────────────────────────────────────
/**
 * A warm seed bakes proxy-mode opencode (KORTIX_LLM_HOTSWAP=1 — Platinum only): the
 * `kortix` provider points at THIS localhost proxy with a placeholder key, and the
 * real per-session gateway token is injected into the proxy at fork adoption. But
 * an account that is not entitled to the LLM gateway never gets a token injected, so
 * a session that keeps routing through the token-less proxy 503s "llm proxy not
 * ready" on EVERY model call forever (and the frontend retries it indefinitely).
 *
 * Returns true when proxy-mode must be TORN DOWN at adoption so the rebuilt opencode
 * config drops the `kortix` provider and opencode falls back to its native catalog —
 * matching Daytona, which never bakes proxy-mode and already degrades this way. The
 * decision keys off `proxyReady` (proxy is listening AND holds a usable token), so
 * an entitled account whose token WAS injected keeps proxy-mode even when the fast
 * hot-swap path is skipped (opencode not yet `ok`, repo error, …).
 */
export function shouldDisableProxyModeGateway(opts: {
  hotswapBaked: boolean
  proxyUrlSet: boolean
  proxyReady: boolean
}): boolean {
  return opts.hotswapBaked && opts.proxyUrlSet && !opts.proxyReady
}
