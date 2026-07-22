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
