import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveManagedOpencodeLaunchEnv } from '../opencode'

const GATEWAY_CATALOG = {
  'glm-5.2': { name: 'GLM 5.2', provider: 'kortix', reasoning: true, tool_call: true },
  'claude-opus-4.8': { name: 'Claude Opus 4.8', provider: 'kortix', reasoning: true, tool_call: true },
  'claude-sonnet-4.6': { name: 'Claude Sonnet 4.6', provider: 'kortix', tool_call: true },
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', provider: 'kortix', tool_call: true },
}

const dirs: string[] = []

function stageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-managed-acp-'))
  dirs.push(dir)
  return dir
}

function configPath(): string {
  return join(stageDir(), 'kortix-opencode.json')
}

function gatewayEnv(): NodeJS.ProcessEnv {
  const catalogFile = join(stageDir(), 'catalog.json')
  writeFileSync(catalogFile, JSON.stringify({ models: GATEWAY_CATALOG }))
  return {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm-gateway/v1',
    KORTIX_LLM_API_KEY: 'kortix_pat_managed_acp',
    KORTIX_LLM_CATALOG_FILE: catalogFile,
    KORTIX_OPENCODE_MODEL: 'kortix/glm-5.2',
    KORTIX_RUNTIME_HARNESS: 'opencode',
    KORTIX_ACP_SERVER_ID: 'session-abc',
  }
}

type KortixOpencodeConfig = {
  provider?: Record<string, { npm?: string; name?: string; options?: Record<string, unknown>; models?: Record<string, unknown> }>
  model?: string
  small_model?: string
  enabled_providers?: string[]
}

function readConfig(env: NodeJS.ProcessEnv): KortixOpencodeConfig {
  expect(typeof env.OPENCODE_CONFIG).toBe('string')
  return JSON.parse(readFileSync(env.OPENCODE_CONFIG as string, 'utf8')) as KortixOpencodeConfig
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('managed ACP OpenCode launch env — the synthetic kortix gateway provider', () => {
  test('registers provider.kortix with the gateway base URL and token', async () => {
    const env = await resolveManagedOpencodeLaunchEnv(gatewayEnv(), { configPath: configPath() })
    const config = readConfig(env)
    expect(config.provider?.kortix).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'Kortix',
      options: {
        baseURL: 'https://api.kortix.test/v1/llm-gateway/v1',
        apiKey: 'kortix_pat_managed_acp',
      },
    })
  })

  test('advertises every managed model id the picker offers', async () => {
    const env = await resolveManagedOpencodeLaunchEnv(gatewayEnv(), { configPath: configPath() })
    const config = readConfig(env)
    expect(Object.keys(config.provider?.kortix?.models ?? {}).sort()).toEqual([
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'deepseek-v4-flash',
      'glm-5.2',
    ])
  })

  test('pins the session model and allowlists the gateway as the only provider', async () => {
    const env = await resolveManagedOpencodeLaunchEnv(gatewayEnv(), { configPath: configPath() })
    const config = readConfig(env)

    expect(config.model).toBe('kortix/glm-5.2')
    expect(config.small_model).toBe('kortix/glm-5.2')
    expect(config.enabled_providers).toEqual(['kortix'])
  })

  test('withholds the provider credentials the gateway mode denies', async () => {
    const env = await resolveManagedOpencodeLaunchEnv({
      ...gatewayEnv(),
      ANTHROPIC_API_KEY: 'sk-ant-leaked',
      OPENAI_API_KEY: 'sk-openai-leaked',
      KORTIX_OPENCODE_DENY_ENV: 'ANTHROPIC_API_KEY,OPENAI_API_KEY',
    }, { configPath: configPath() })

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.KORTIX_LLM_API_KEY).toBe('kortix_pat_managed_acp')
  })

  test('leaves a session without a gateway untouched', async () => {
    const path = configPath()
    const env = await resolveManagedOpencodeLaunchEnv({}, { configPath: path })

    expect(env.OPENCODE_CONFIG).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })
})
