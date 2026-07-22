import { describe, expect, it } from 'bun:test'

import { isolateHarnessAuthEnv, resolveAcpHarnessLaunchEnv } from './harness-registry'

// claude-agent-acp advertises its most-permissive `bypassPermissions` mode only
// when `ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX` holds. The Kortix runtime runs
// the adapter as root inside a disposable per-session sandbox, so the launch env
// MUST declare `IS_SANDBOX` — otherwise `bypassPermissions` never appears in the
// session's advertised modes and a fresh Claude session can't default to
// prompt-free bypass (it would fall back to `acceptEdits`, which still prompts
// for every command). See resolveDefaultModeToApply (@kortix/sdk).
function claudeLaunch(overrides: Record<string, string> = {}): Record<string, string> | undefined {
  const env: NodeJS.ProcessEnv = {
    KORTIX_API_URL: 'https://api.example.com/v1',
    KORTIX_TOKEN: 'kortix_sb_test',
    ...overrides,
  }
  return resolveAcpHarnessLaunchEnv('claude', isolateHarnessAuthEnv(env))
}

describe('claude launch env unlocks bypassPermissions', () => {
  it('sets IS_SANDBOX=1 on the managed-gateway path', () => {
    expect(claudeLaunch()?.IS_SANDBOX).toBe('1')
  })

  it('sets IS_SANDBOX=1 with a direct Anthropic key', () => {
    expect(claudeLaunch({ ANTHROPIC_API_KEY: 'sk-ant-test' })?.IS_SANDBOX).toBe('1')
  })

  it('sets IS_SANDBOX=1 for an anthropic-compatible custom provider', () => {
    const launch = claudeLaunch({
      CUSTOM_LLM_PROTOCOL: 'anthropic',
      CUSTOM_LLM_BASE_URL: 'https://byo.example.com',
      CUSTOM_LLM_API_KEY: 'byo-key',
    })
    expect(launch?.IS_SANDBOX).toBe('1')
  })

  it('does NOT leak IS_SANDBOX onto other harnesses', () => {
    const codex = resolveAcpHarnessLaunchEnv(
      'codex',
      isolateHarnessAuthEnv({ KORTIX_API_URL: 'https://api.example.com/v1', KORTIX_TOKEN: 'kortix_sb_test' }),
    )
    expect(codex?.IS_SANDBOX).toBeUndefined()
  })
})
