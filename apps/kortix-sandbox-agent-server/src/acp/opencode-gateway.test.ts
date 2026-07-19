import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isolateHarnessAuthEnv, resolveAcpHarnessLaunchEnv } from './harness-registry'

const GATEWAY_ENV = {
  KORTIX_LLM_BASE_URL: 'https://api.kortix.test/router/llm',
  KORTIX_LLM_API_KEY: 'kortix_pat_gateway-key',
}

function opencodeConfig(env: NodeJS.ProcessEnv): Record<string, any> {
  const launchEnv = resolveAcpHarnessLaunchEnv('opencode', isolateHarnessAuthEnv(env))
  expect(launchEnv?.OPENCODE_CONFIG_CONTENT).toBeDefined()
  return JSON.parse(launchEnv!.OPENCODE_CONFIG_CONTENT as string)
}

function catalogFileWith(models: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-llm-catalog-'))
  const path = join(dir, 'catalog.json')
  writeFileSync(path, JSON.stringify({ models }))
  return path
}

describe('OpenCode managed-gateway provider mount', () => {
  it('mounts only the kortix provider so native Zen cannot become the fallback', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
    })

    expect(config.provider.kortix.npm).toBe('@ai-sdk/openai-compatible')
    expect(config.provider.kortix.options.baseURL).toBe(GATEWAY_ENV.KORTIX_LLM_BASE_URL)
    expect(config.provider.kortix.options.apiKey).toBe(GATEWAY_ENV.KORTIX_LLM_API_KEY)
    expect(config.enabled_providers).toEqual(['kortix'])
    expect(Object.keys(config.provider.kortix.models).length).toBeGreaterThan(0)
  })

  it('defaults the main and small model to kortix/auto', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
    })
    expect(config.model).toBe('kortix/auto')
    expect(config.small_model).toBe('kortix/auto')
  })

  it('keeps an explicit session model while retaining the provider allowlist', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_RUNTIME_MODEL: 'kortix/codex/gpt-5.6-sol',
    })
    expect(config.model).toBe('kortix/codex/gpt-5.6-sol')
    expect(config.small_model).toBe('kortix/auto')
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  it('replaces inherited native OpenCode models with the managed automatic model', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'opencode/big-pickle',
        small_model: 'opencode/big-pickle',
      }),
    })
    expect(config.model).toBe('kortix/auto')
    expect(config.small_model).toBe('kortix/auto')
  })

  it('preserves inherited managed main and small models', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'kortix/anthropic/claude-sonnet-4.6',
        small_model: 'kortix/google/gemini-3.5-flash',
      }),
    })
    expect(config.model).toBe('kortix/anthropic/claude-sonnet-4.6')
    expect(config.small_model).toBe('kortix/google/gemini-3.5-flash')
  })

  it('composes managed mode with the logical Kortix agent', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_NATIVE_AGENT: 'kortix',
    })
    expect(config.provider.kortix).toBeDefined()
    expect(config.default_agent).toBe('kortix')
  })

  it('uses a readable per-session catalog and backfills missing limits', () => {
    const catalogPath = catalogFileWith({
      'alibaba-cn/deepseek-v4-flash': { name: 'DeepSeek V4 Flash (CN)' },
      'unknown/never-seen': { name: 'Never Seen' },
      'kept/as-is': { name: 'Kept', limit: { context: 42, output: 7 } },
    })
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_LLM_CATALOG_FILE: catalogPath,
    })
    const models = config.provider.kortix.models
    expect(models['alibaba-cn/deepseek-v4-flash'].limit.context).toBe(1_048_576)
    expect(models['unknown/never-seen'].limit).toEqual({ context: 200_000, output: 32_000 })
    expect(models['kept/as-is'].limit).toEqual({ context: 42, output: 7 })
  })

  it('falls back to a non-empty catalog when the explicit file is unreadable', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_LLM_CATALOG_FILE: '/nonexistent/kortix-catalog.json',
    })
    expect(config.provider.kortix.models.auto).toBeDefined()
    expect(Object.keys(config.provider.kortix.models).length).toBeGreaterThan(1)
  })

  it('does not mount managed models for an OpenAI-compatible BYOK session', () => {
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'openai_compatible',
      CUSTOM_LLM_PROTOCOL: 'openai',
      CUSTOM_LLM_BASE_URL: 'https://byok.example.com',
      CUSTOM_LLM_API_KEY: 'byok-key',
    })
    expect(config.provider.kortix).toBeUndefined()
    expect(config.enabled_providers).toBeUndefined()
    expect(config.provider.custom.options.baseURL).toBe('https://byok.example.com')
  })

  it('does not mount managed models for a native-config session', () => {
    const launchEnv = resolveAcpHarnessLaunchEnv(
      'opencode',
      isolateHarnessAuthEnv({
        ...GATEWAY_ENV,
        KORTIX_RUNTIME_AUTH_KIND: 'native_config',
      }),
    )
    expect(launchEnv?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('preserves native OpenCode behavior when gateway credentials are absent', () => {
    expect(resolveAcpHarnessLaunchEnv('opencode', isolateHarnessAuthEnv({}))).toBeUndefined()
  })
})
