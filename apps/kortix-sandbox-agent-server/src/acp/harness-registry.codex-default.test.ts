import { describe, expect, it } from 'bun:test'

import { isolateHarnessAuthEnv, resolveAcpHarnessLaunchEnv } from './harness-registry'

// The advertised, ChatGPT-accepted codex model values codex-acp itself lists
// at session/new (kortix.acp_session_envelopes) and that the composer feeds as
// pills. The subscription relay forwards a model id VERBATIM to the ChatGPT
// backend, so the launch default MUST be one of these bare ids — never a
// gateway-style `openai/…`-prefixed id, which the backend rejects (400).
const ADVERTISED_CODEX_VALUES = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
])

function codexSubscriptionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
    KORTIX_API_URL: 'https://api.example.com/v1',
    KORTIX_EXECUTOR_TOKEN: 'kortix_pat_test_secret',
    ...overrides,
  }
}

function codexConfigModel(env: NodeJS.ProcessEnv): string | undefined {
  const launch = resolveAcpHarnessLaunchEnv('codex', isolateHarnessAuthEnv(env))
  const raw = launch?.CODEX_CONFIG
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as { model?: unknown }
  return typeof parsed.model === 'string' ? parsed.model : undefined
}

describe('codex subscription default model', () => {
  it('defaults to a bare, advertised, ChatGPT-accepted model — never an openai/-prefixed gateway id', () => {
    const model = codexConfigModel(codexSubscriptionEnv())
    expect(model).toBe('gpt-5.6-sol')
    expect(ADVERTISED_CODEX_VALUES.has(model as string)).toBe(true)
    expect(model?.startsWith('openai/')).toBe(false)
  })

  it('honors a caller-selected advertised runtime model over the default', () => {
    const model = codexConfigModel(codexSubscriptionEnv({ KORTIX_RUNTIME_MODEL: 'gpt-5.5' }))
    expect(model).toBe('gpt-5.5')
    expect(ADVERTISED_CODEX_VALUES.has(model as string)).toBe(true)
  })

  it('points the subscription session at the /router/codex-subscription relay with the executor token', () => {
    const launch = resolveAcpHarnessLaunchEnv('codex', isolateHarnessAuthEnv(codexSubscriptionEnv()))
    const auth = JSON.parse(launch?.DEFAULT_AUTH_REQUEST ?? '{}') as {
      _meta?: { gateway?: { baseUrl?: string; headers?: Record<string, string> } }
    }
    expect(auth._meta?.gateway?.baseUrl).toBe('https://api.example.com/v1/router/codex-subscription')
    expect(auth._meta?.gateway?.headers?.Authorization).toBe('Bearer kortix_pat_test_secret')
  })

  it('still routes the Kortix-managed (non-subscription) codex path through /router/openai', () => {
    // The managed-gateway default branch keeps its gateway-style default — the
    // fix is scoped to the subscription branch only.
    const launch = resolveAcpHarnessLaunchEnv('codex', isolateHarnessAuthEnv({
      KORTIX_API_URL: 'https://api.example.com/v1',
      KORTIX_TOKEN: 'kortix_sb_managed',
    }))
    const auth = JSON.parse(launch?.DEFAULT_AUTH_REQUEST ?? '{}') as {
      _meta?: { gateway?: { baseUrl?: string } }
    }
    expect(auth._meta?.gateway?.baseUrl).toBe('https://api.example.com/v1/router/openai')
  })
})

// 2026-07-22 Codex-subscription widening: Pi (which speaks OpenAI Responses
// natively) is now pointable at the SAME subscription relay codex-acp uses, so
// a connected Codex subscription drives Pi with zero credit billing and the
// user's own credential resolved server-side. These mirror the codex cases
// above, in Pi's own config vocabulary (KORTIX_PI_MODELS_JSON, not CODEX_CONFIG/
// DEFAULT_AUTH_REQUEST).
type PiProvider = {
  baseUrl?: string
  api?: string
  apiKey?: string
  authHeader?: boolean
  models?: Array<{ id?: string; name?: string }>
}
function piKortixProvider(env: NodeJS.ProcessEnv): PiProvider | undefined {
  const launch = resolveAcpHarnessLaunchEnv('pi', isolateHarnessAuthEnv(env))
  const raw = launch?.KORTIX_PI_MODELS_JSON
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as { providers?: Record<string, PiProvider> }
  return parsed.providers?.kortix
}

describe('pi + codex subscription', () => {
  it('points Pi at the /router/codex-subscription relay (openai-responses) with the executor token, NOT /router/openai', () => {
    const provider = piKortixProvider(codexSubscriptionEnv())
    expect(provider?.baseUrl).toBe('https://api.example.com/v1/router/codex-subscription')
    expect(provider?.api).toBe('openai-responses')
    expect(provider?.authHeader).toBe(true)
    // Executor token embedded so Pi sends `Authorization: Bearer <token>` — the
    // relay validates it as a project-scoped account token, then resolves the
    // user's own Codex credential server-side.
    expect(provider?.apiKey).toBe('kortix_pat_test_secret')
    // NEVER the generic Kortix-managed key proxy (that path bills Kortix credits
    // and bypasses the subscription).
    expect(provider?.baseUrl).not.toContain('/router/openai')
  })

  it('defaults to a bare, advertised, ChatGPT-accepted model — never an openai/-prefixed gateway id', () => {
    const provider = piKortixProvider(codexSubscriptionEnv())
    const model = provider?.models?.[0]?.id
    expect(model).toBe('gpt-5.6-sol')
    expect(ADVERTISED_CODEX_VALUES.has(model as string)).toBe(true)
    expect(model?.startsWith('openai/')).toBe(false)
  })

  it('honors a caller-selected advertised runtime model over the default', () => {
    const provider = piKortixProvider(codexSubscriptionEnv({ KORTIX_RUNTIME_MODEL: 'gpt-5.5' }))
    expect(provider?.models?.[0]?.id).toBe('gpt-5.5')
  })

  it('strips a canonical codex/ prefix so the id lands bare (relay forwards it verbatim; the backend rejects prefixed ids)', () => {
    const provider = piKortixProvider(codexSubscriptionEnv({ KORTIX_RUNTIME_MODEL: 'codex/gpt-5.5' }))
    expect(provider?.models?.[0]?.id).toBe('gpt-5.5')
  })

  it('falls back to the executor-token alias (KORTIX_CLI_TOKEN) when KORTIX_EXECUTOR_TOKEN is absent', () => {
    const provider = piKortixProvider({
      KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
      KORTIX_API_URL: 'https://api.example.com/v1',
      KORTIX_CLI_TOKEN: 'kortix_pat_cli_alias',
    })
    expect(provider?.apiKey).toBe('kortix_pat_cli_alias')
    expect(provider?.baseUrl).toBe('https://api.example.com/v1/router/codex-subscription')
  })

  it('fails loudly with no executor token instead of silently falling back to the Kortix-managed gateway key', () => {
    expect(() =>
      resolveAcpHarnessLaunchEnv(
        'pi',
        isolateHarnessAuthEnv({
          KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
          KORTIX_API_URL: 'https://api.example.com/v1',
          // No executor/CLI token — must throw, never fall through to the
          // managed-gateway default that bills Kortix credits.
        }),
      ),
    ).toThrow(/executor token/)
  })

  it('fails loudly with no KORTIX_API_URL', () => {
    expect(() =>
      resolveAcpHarnessLaunchEnv(
        'pi',
        isolateHarnessAuthEnv({
          KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
          KORTIX_EXECUTOR_TOKEN: 'kortix_pat_test_secret',
        }),
      ),
    ).toThrow()
  })

  it('still routes the Kortix-managed (non-subscription) pi path through /router/openai', () => {
    // Pin that the widening is scoped to the subscription branch: a managed
    // (KORTIX_TOKEN, no auth-kind) Pi session keeps its /router/openai default.
    const provider = piKortixProvider({
      KORTIX_API_URL: 'https://api.example.com/v1',
      KORTIX_TOKEN: 'kortix_sb_managed',
    })
    expect(provider?.baseUrl).toBe('https://api.example.com/v1/router/openai')
  })
})

// 2026-07-22 Codex-subscription widening: OpenCode. Unlike Pi/codex-acp (which
// speak OpenAI Responses natively and relay through /router/codex-subscription),
// OpenCode keeps its NORMAL Kortix managed-gateway provider — baseURL = the
// in-process `/v1/llm` gateway, apiKey = the per-session executor PAT (the same
// KORTIX_LLM_* env a managed_gateway session gets) — and just SELECTS the
// ChatGPT-backend codex model in the gateway's `codex/*` namespace. The AI-SDK
// gateway's existing `codex/*` path then resolves the user's own credential
// server-side and drives the ChatGPT Responses backend at `billingMode:'none'`.
// So there is no bespoke translation endpoint; the model id (`kortix/codex/<id>`
// → wire `codex/<id>`) is the whole switch.
type OpencodeProvider = {
  npm?: string
  options?: { baseURL?: string; apiKey?: string }
  models?: Record<string, { name?: string }>
}
function opencodeConfig(env: NodeJS.ProcessEnv): {
  provider?: { kortix?: OpencodeProvider }
  enabled_providers?: string[]
  model?: string
  small_model?: string
  default_agent?: string
} {
  const launch = resolveAcpHarnessLaunchEnv('opencode', isolateHarnessAuthEnv(env))
  return JSON.parse(launch?.OPENCODE_CONFIG_CONTENT ?? '{}')
}

// OpenCode's gateway lane needs the managed-gateway env (KORTIX_LLM_BASE_URL +
// KORTIX_LLM_API_KEY = the executor PAT), NOT the raw-relay KORTIX_API_URL/
// executor-token pair the codex/pi Responses branches use.
function opencodeCodexSubEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
    KORTIX_LLM_BASE_URL: 'https://api.example.com/v1/llm',
    KORTIX_LLM_API_KEY: 'kortix_pat_executor_secret',
    ...overrides,
  }
}

describe('opencode + codex subscription (AI-SDK gateway codex/* lane, NOT a translation endpoint)', () => {
  it('keeps the normal managed-gateway provider (baseURL /v1/llm, executor PAT) — never a bespoke relay endpoint', () => {
    const cfg = opencodeConfig(opencodeCodexSubEnv())
    const provider = cfg.provider?.kortix
    expect(provider?.npm).toBe('@ai-sdk/openai-compatible')
    // The IN-PROCESS gateway origin — the same one a managed_gateway session
    // uses. The gateway routes `codex/*` to the user's subscription internally.
    expect(provider?.options?.baseURL).toBe('https://api.example.com/v1/llm')
    // Executor PAT: the gateway resolves it to the launching user's project/user
    // id, then resolves THAT user's Codex credential server-side.
    expect(provider?.options?.apiKey).toBe('kortix_pat_executor_secret')
    // NEVER a bespoke /router/codex-subscription translation endpoint.
    expect(provider?.options?.baseURL).not.toContain('/router/codex-subscription')
    expect(cfg.enabled_providers).toEqual(['kortix'])
  })

  it('defaults to the codex/-namespaced advertised model so the gateway routes it to the subscription (provider === codex)', () => {
    const cfg = opencodeConfig(opencodeCodexSubEnv())
    // OpenCode names the model provider-prefixed (kortix/<id>); the WIRE model
    // it sends is the provider-model key `codex/gpt-5.6-sol`, which the gateway's
    // resolve-candidates keys on (provider === 'codex').
    expect(cfg.model).toBe('kortix/codex/gpt-5.6-sol')
    expect(cfg.small_model).toBe('kortix/codex/gpt-5.6-sol')
    const wireIds = Object.keys(cfg.provider?.kortix?.models ?? {})
    expect(wireIds).toEqual(['codex/gpt-5.6-sol'])
    // Bare advertised id under the codex/ prefix — never an openai/-prefixed id.
    expect(ADVERTISED_CODEX_VALUES.has(wireIds[0]!.replace(/^codex\//, ''))).toBe(true)
    expect(wireIds[0]?.startsWith('openai/')).toBe(false)
  })

  it('honors a caller-selected advertised runtime model over the default', () => {
    const cfg = opencodeConfig(opencodeCodexSubEnv({ KORTIX_RUNTIME_MODEL: 'gpt-5.5' }))
    expect(cfg.model).toBe('kortix/codex/gpt-5.5')
    expect(Object.keys(cfg.provider?.kortix?.models ?? {})).toEqual(['codex/gpt-5.5'])
  })

  it('normalizes an already-codex/-prefixed runtime model (from the gateway-namespaced resolver) to exactly one prefix', () => {
    const cfg = opencodeConfig(opencodeCodexSubEnv({ KORTIX_RUNTIME_MODEL: 'codex/gpt-5.5' }))
    expect(Object.keys(cfg.provider?.kortix?.models ?? {})).toEqual(['codex/gpt-5.5'])
    expect(cfg.model).toBe('kortix/codex/gpt-5.5')
  })

  it('fails loudly for the ACTIVE opencode launch with no gateway env (KORTIX_LLM_*) instead of silently falling back to a non-subscription route', () => {
    expect(() =>
      resolveAcpHarnessLaunchEnv(
        'opencode',
        isolateHarnessAuthEnv({
          KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
          KORTIX_RUNTIME_HARNESS: 'opencode',
          // No KORTIX_LLM_BASE_URL / KORTIX_LLM_API_KEY.
        }),
      ),
    ).toThrow(/gateway/)
  })

  it('does NOT throw when opencode is only a diagnostic snapshot of a non-opencode (codex/pi) codex_subscription session — degrades to native so the active harness still launches', () => {
    // createAcpHarnessRegistry eagerly evaluates every harness; a codex/pi
    // codex_subscription session (raw-relay lane) legitimately has no KORTIX_LLM_*.
    const launch = resolveAcpHarnessLaunchEnv(
      'opencode',
      isolateHarnessAuthEnv({
        KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
        KORTIX_RUNTIME_HARNESS: 'pi',
        // No KORTIX_LLM_* — opencode is not the active harness, so no throw.
      }),
    )
    // Degrades to just the PATH fallback (native), no kortix provider config.
    expect(launch?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('still routes the Kortix-managed (non-subscription) opencode path through the full gateway catalog, not the codex model', () => {
    // Pin that the widening is scoped to the subscription branch: a managed
    // OpenCode session (same KORTIX_LLM_* env, but managed_gateway auth-kind)
    // keeps its normal buildOpencodeKortixProvider catalog + kortix/auto default,
    // never the single codex model.
    const cfg = opencodeConfig({
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_LLM_BASE_URL: 'https://api.example.com/v1/llm',
      KORTIX_LLM_API_KEY: 'kortix_pat_executor_secret',
    })
    expect(cfg.provider?.kortix?.options?.baseURL).toBe('https://api.example.com/v1/llm')
    expect(cfg.model).toBe('kortix/auto')
    expect(Object.keys(cfg.provider?.kortix?.models ?? {})).not.toEqual(['codex/gpt-5.6-sol'])
  })
})
