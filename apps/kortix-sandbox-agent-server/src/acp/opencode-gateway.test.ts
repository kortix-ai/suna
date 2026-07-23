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

  it('projects baked catalog entries to the whitelisted gateway-model shape (regression: opencode schema collision on provider)', () => {
    // Real failing shape from .superpowers/sdd/d3-opencode-init-diagnosis.md:
    // the baked /opt/kortix/llm-catalog.json entry for "daoxe/gpt-5.5" carries a
    // string `provider` field plus other passthrough metadata. OpenCode's own
    // config schema expects `provider.<name>.models.<id>.provider` to be an
    // object (or absent), so copying this raw entry verbatim crashes `opencode
    // acp` at boot with "Expected object | undefined, got \"daoxe\" ...provider".
    const catalogPath = catalogFileWith({
      'daoxe/gpt-5.5': {
        name: 'GPT-5.5',
        provider: 'daoxe',
        released: '2026-04-23',
        family: 'gpt',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
        tool_call: true,
        attachment: true,
        temperature: false,
        structured_output: true,
        cost: { input: 5, output: 30, cache_read: 0.5 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    })
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_LLM_CATALOG_FILE: catalogPath,
    })
    const model = config.provider.kortix.models['daoxe/gpt-5.5']
    expect(model).toBeDefined()
    expect(model.provider).toBeUndefined()
    expect(model.released).toBeUndefined()
    expect(model.family).toBeUndefined()
    expect(model.cost).toBeUndefined()
    expect(model.modalities).toBeUndefined()
    expect(model.reasoning_options).toBeUndefined()
    expect(model.structured_output).toBeUndefined()
    expect(Object.keys(model).sort()).toEqual(
      ['attachment', 'limit', 'name', 'reasoning', 'temperature', 'tool_call'].sort(),
    )
    expect(model.limit).toEqual({ context: 1_050_000, output: 128_000 })
  })

  it('falls back when a readable catalog contains an invalid model entry', () => {
    const catalogPath = catalogFileWith({ broken: null })
    const config = opencodeConfig({
      ...GATEWAY_ENV,
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_LLM_CATALOG_FILE: catalogPath,
    })
    expect(config.provider.kortix.models.broken).toBeUndefined()
    expect(config.provider.kortix.models.auto).toBeDefined()
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

  // OpenCode always carries a PATH fallback (see the `id === 'opencode'`
  // branch of resolveAcpHarnessLaunchEnv — Platinum microVMs can boot with no
  // PATH at all, and `AcpProcess` spawns OpenCode by bare command name), so
  // "no gateway config" now means "launch env with only PATH", not undefined.
  const PATH_ONLY = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }

  it('preserves native OpenCode behavior when gateway credentials are absent', () => {
    expect(resolveAcpHarnessLaunchEnv('opencode', isolateHarnessAuthEnv({}))).toEqual(PATH_ONLY)
  })

  it('does not emit an explicit managed model when gateway credentials are incomplete', () => {
    for (const env of [
      {
        KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
        KORTIX_RUNTIME_MODEL: 'kortix/codex/gpt-5.6-sol',
      },
      {
        KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
        KORTIX_RUNTIME_MODEL: 'kortix/codex/gpt-5.6-sol',
        KORTIX_LLM_BASE_URL: GATEWAY_ENV.KORTIX_LLM_BASE_URL,
      },
      {
        KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
        KORTIX_RUNTIME_MODEL: 'kortix/codex/gpt-5.6-sol',
        KORTIX_LLM_API_KEY: GATEWAY_ENV.KORTIX_LLM_API_KEY,
      },
    ]) {
      expect(resolveAcpHarnessLaunchEnv('opencode', isolateHarnessAuthEnv(env))).toEqual(PATH_ONLY)
    }
  })
})
