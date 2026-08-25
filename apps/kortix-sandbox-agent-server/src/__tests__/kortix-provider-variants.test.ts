import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOpencodeConfigContent, resetManagedModelsStateForTests } from '../opencode'
import { resetManagedReconcileForTests } from '../main'

// The composer's Thinking control lists `Object.keys(model.variants)` and sends
// the pick as `variant` on the prompt. On-gateway the web derives those ids
// from the API's `reasoning_options` (packages/sdk provider-selection.ts);
// OpenCode resolves the id against THIS provider map at prompt time. The two
// must agree, or a picked tier silently does nothing — so the kortix provider
// publishes one variant per published tier, mapped to the field
// `@ai-sdk/openai-compatible` serializes as `reasoning_effort` (the gateway's
// inbound contract), mirroring @kortix/llm-catalog's
// generationControlCapabilities (effort values verbatim; budget_tokens →
// low/medium/high). OpenCode 1.18 keeps explicit config `variants` verbatim
// (verified locally: all six GPT-5.6 tiers came back on /config/providers,
// where its own derivation for an openai-compatible package keeps only
// low/medium/high).

const GATEWAY = {
  KORTIX_WORKSPACE: '/workspace',
  KORTIX_LLM_BASE_URL: 'https://gw.kortix.test/v1',
  KORTIX_TOKEN: 'gw-key',
}

const BAKED = {
  models: {
    'amazon-bedrock/global.openai.gpt-5.6-sol': {
      name: 'GPT-5.6 Sol (Global)',
      provider: 'amazon-bedrock',
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
      limit: { context: 400_000, output: 128_000 },
    },
    'anthropic/claude-sonnet-4-5': {
      name: 'Claude Sonnet 4.5',
      provider: 'anthropic',
      reasoning: true,
      reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
      limit: { context: 200_000, output: 64_000 },
    },
    'openai/gpt-4.1': { name: 'GPT-4.1', provider: 'openai', reasoning: false, limit: { context: 1_000_000 } },
    'zai/glm-5': { name: 'GLM-5', provider: 'zai', reasoning: true, reasoning_options: [], limit: { context: 200_000 } },
    'openai/gpt-5.6-sol': {
      name: 'GPT-5.6 Sol',
      provider: 'openai',
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      variants: { deep: { reasoningEffort: 'high', reasoningSummary: 'auto' } },
      limit: { context: 400_000 },
    },
  },
}

const realFetch = globalThis.fetch
const tempDirs: string[] = []

type ProviderConfig = {
  provider: { kortix: { models: Record<string, { variants?: Record<string, Record<string, unknown>> }> } }
}

async function bakedCatalogFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-variants-'))
  tempDirs.push(dir)
  const file = join(dir, 'catalog.json')
  await writeFile(file, JSON.stringify(BAKED))
  return file
}

beforeEach(() => {
  resetManagedModelsStateForTests()
  resetManagedReconcileForTests()
  // No managed fetch in these tests — the overlay path is covered elsewhere.
  globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = realFetch
  resetManagedModelsStateForTests()
  resetManagedReconcileForTests()
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function kortixModels() {
  const raw = await buildOpencodeConfigContent({
    ...GATEWAY,
    KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
  } as NodeJS.ProcessEnv)
  return (JSON.parse(raw!) as ProviderConfig).provider.kortix.models
}

describe('kortix provider variants', () => {
  test('an effort ladder becomes one variant per tier, verbatim and in order, each carrying reasoningEffort', async () => {
    const models = await kortixModels()
    const sol = models['amazon-bedrock/global.openai.gpt-5.6-sol']!
    expect(Object.keys(sol.variants ?? {})).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(sol.variants?.xhigh).toEqual({ reasoningEffort: 'xhigh' })
    expect(sol.variants?.none).toEqual({ reasoningEffort: 'none' })
  })

  test('a budget_tokens-only knob (mainline Claude) gets the gateway tiers the routing clamp accepts', async () => {
    const models = await kortixModels()
    expect(Object.keys(models['anthropic/claude-sonnet-4-5']?.variants ?? {})).toEqual(['low', 'medium', 'high'])
  })

  test('a model without a knob gets NO variants key — never a fabricated ladder', async () => {
    const models = await kortixModels()
    expect(models['openai/gpt-4.1']?.variants).toBeUndefined()
    expect(models['zai/glm-5']?.variants).toBeUndefined()
  })

  test('an explicit variants map in the catalog is kept verbatim', async () => {
    const models = await kortixModels()
    expect(models['openai/gpt-5.6-sol']?.variants).toEqual({
      deep: { reasoningEffort: 'high', reasoningSummary: 'auto' },
    })
  })
})
