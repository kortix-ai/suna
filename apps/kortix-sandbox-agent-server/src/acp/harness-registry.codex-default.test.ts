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
