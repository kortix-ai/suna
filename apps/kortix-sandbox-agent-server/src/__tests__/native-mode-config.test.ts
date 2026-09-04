import { describe, expect, test } from 'bun:test'

import { buildOpencodeConfigContent } from '../opencode'

// Native mode = the project's `llm_gateway` flag is OFF: no KORTIX_LLM_* env
// reaches the box, provider API keys sit in the process env, and OpenCode's own
// provider management owns catalog + connection + default-model selection. The
// daemon's only jobs here are (a) layering the session's model pin into the
// config (OpenCode's default is otherwise catalog-order-dependent) and
// (b) scrubbing `kortix/…` refs a gateway→native toggle left behind.

describe('buildOpencodeConfigContent — native mode (no gateway env)', () => {
  test('emits no kortix provider and no enabled_providers lockout', async () => {
    const content = await buildOpencodeConfigContent({
      KORTIX_OPENCODE_MODEL: 'anthropic/claude-sonnet-4-6',
    })
    const parsed = JSON.parse(content!)
    expect(parsed.provider).toBeUndefined()
    expect(parsed.enabled_providers).toBeUndefined()
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
  })

  test('with nothing session-specific to inject, only the Kortix-managed overlay remains', async () => {
    const content = await buildOpencodeConfigContent({})
    // autoupdate:false is unconditional (Essentia 2026-08-22/25: OpenCode's
    // self-upgrade via plain `pnpm add -g` left a postinstall-less stub).
    expect(JSON.parse(content!)).toEqual({ autoupdate: false })
  })

  test('the session pin does not clobber an explicit base-config model', async () => {
    const content = await buildOpencodeConfigContent({
      KORTIX_OPENCODE_MODEL: 'anthropic/claude-sonnet-4-6',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'openai/gpt-5.2' }),
    })
    const parsed = JSON.parse(content!)
    expect(parsed.model).toBe('openai/gpt-5.2')
  })

  test('a stale kortix/<provider>/<model> session pin unwraps to the native ref', async () => {
    const content = await buildOpencodeConfigContent({
      KORTIX_OPENCODE_MODEL: 'kortix/anthropic/claude-sonnet-4-6',
    })
    const parsed = JSON.parse(content!)
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
  })

  test('a stale bare kortix/<managed-id> session pin injects nothing', async () => {
    // No native provider maps to a bare managed id, and the clean base config
    // needs no scrub — so there is nothing to inject at all. The pin is also
    // ignored at prompt time (resolveOpencodeModel returns undefined for it).
    const content = await buildOpencodeConfigContent({
      KORTIX_OPENCODE_MODEL: 'kortix/glm-5.3-flash',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ small_model: 'anthropic/claude-haiku-4-5' }),
    })
    const parsed = JSON.parse(content!)
    expect(parsed.model).toBeUndefined()
    expect(parsed.small_model).toBe('anthropic/claude-haiku-4-5')
    expect(parsed.autoupdate).toBe(false)
  })

  test('a base config carrying kortix refs IS rebuilt and scrubbed even with nothing else to inject', async () => {
    const content = await buildOpencodeConfigContent({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'kortix/anthropic/claude-sonnet-4-6' }),
    })
    const parsed = JSON.parse(content!)
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-6')
  })

  test('scrubs stale kortix refs from the merged base config', async () => {
    const content = await buildOpencodeConfigContent({
      KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({
        model: 'kortix/glm-5.3-flash',
        small_model: 'kortix/anthropic/claude-haiku-4-5',
        agent: {
          support: { model: 'kortix/codex/gpt-5.6-sol' },
          research: { model: 'anthropic/claude-opus-4-8' },
        },
      }),
    })
    const parsed = JSON.parse(content!)
    // Bare managed id → dropped; nested wire refs → unwrapped; native → kept.
    expect(parsed.model).toBeUndefined()
    expect(parsed.small_model).toBe('anthropic/claude-haiku-4-5')
    expect(parsed.agent.support.model).toBe('codex/gpt-5.6-sol')
    expect(parsed.agent.research.model).toBe('anthropic/claude-opus-4-8')
  })

  test('gateway mode is untouched: kortix provider + lockout still emitted', async () => {
    const content = await buildOpencodeConfigContent({
      KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
      KORTIX_TOKEN: 'tok-123',
    })
    const parsed = JSON.parse(content!)
    expect(parsed.provider.kortix).toBeDefined()
    expect(parsed.enabled_providers).toEqual(['kortix'])
  })
})
