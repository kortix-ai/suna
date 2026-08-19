import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOpencodeConfigContent } from '../opencode'

// The AI-SDK-native transport toggle (`KORTIX_LLM_AI_SDK_NATIVE`). It selects the
// opencode provider PACKAGE only:
//   OFF/absent → `@ai-sdk/openai-compatible` (opencode POSTs `/chat/completions`,
//                the historical default — ZERO behavior change).
//   ON         → `@ai-sdk/gateway` (opencode POSTs the gateway's native
//                `/language-model` ingress with the model id in the
//                `ai-language-model-id` header).
// baseURL/apiKey/models are IDENTICAL for both, so the model picker + cost wiring
// are unaffected by the flag.

const GATEWAY = {
  KORTIX_WORKSPACE: '/workspace',
  KORTIX_LLM_BASE_URL: 'https://gw.kortix.test/v1',
  KORTIX_LLM_API_KEY: 'gw-key',
}

const BAKED = {
  models: { 'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', provider: 'kortix' } },
}

const tempDirs: string[] = []

async function bakedCatalogFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-aisdk-native-'))
  tempDirs.push(dir)
  const file = join(dir, 'catalog.json')
  await writeFile(file, JSON.stringify(BAKED))
  return file
}

type ProviderConfig = {
  provider: { kortix: { npm: string; options: { baseURL: string; apiKey: string } } }
}

function kortixProvider(raw: string | undefined): ProviderConfig['provider']['kortix'] {
  return (JSON.parse(raw!) as ProviderConfig).provider.kortix
}

afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

describe('KORTIX_LLM_AI_SDK_NATIVE provider selection', () => {
  test('OFF/absent → @ai-sdk/openai-compatible (baseURL/apiKey preserved)', async () => {
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
    } as NodeJS.ProcessEnv)
    const kortix = kortixProvider(raw)
    expect(kortix.npm).toBe('@ai-sdk/openai-compatible')
    expect(kortix.options.baseURL).toBe(GATEWAY.KORTIX_LLM_BASE_URL)
    expect(kortix.options.apiKey).toBe(GATEWAY.KORTIX_LLM_API_KEY)
  })

  test('ON (=1) → @ai-sdk/gateway, same baseURL/apiKey/models', async () => {
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_AI_SDK_NATIVE: '1',
      KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
    } as NodeJS.ProcessEnv)
    const kortix = kortixProvider(raw)
    expect(kortix.npm).toBe('@ai-sdk/gateway')
    // baseURL is unchanged — the gateway mounts `/language-model` under the same
    // `/v1/llm` prefix, so the SAME base works for either transport.
    expect(kortix.options.baseURL).toBe(GATEWAY.KORTIX_LLM_BASE_URL)
    expect(kortix.options.apiKey).toBe(GATEWAY.KORTIX_LLM_API_KEY)
  })

  test.each(['true', 'yes', 'on', 'ON', ' On '])(
    'ON via truthy string %p → @ai-sdk/gateway',
    async (value) => {
      const raw = await buildOpencodeConfigContent({
        ...GATEWAY,
        KORTIX_LLM_AI_SDK_NATIVE: value,
        KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
      } as NodeJS.ProcessEnv)
      expect(kortixProvider(raw).npm).toBe('@ai-sdk/gateway')
    },
  )

  test.each(['0', 'false', 'no', ''])(
    'OFF via falsy string %p → @ai-sdk/openai-compatible',
    async (value) => {
      const raw = await buildOpencodeConfigContent({
        ...GATEWAY,
        KORTIX_LLM_AI_SDK_NATIVE: value,
        KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
      } as NodeJS.ProcessEnv)
      expect(kortixProvider(raw).npm).toBe('@ai-sdk/openai-compatible')
    },
  )
})
