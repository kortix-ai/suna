import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiModels, compactionSettings } from '@/harness/pi/model'

// The image-baked catalog never holds a project's custom endpoint models.
const dir = mkdtempSync(join(tmpdir(), 'pi-model-limits-'))
const bakedFile = join(dir, 'catalog.json')
writeFileSync(bakedFile, JSON.stringify({ models: { 'baked/model': { name: 'Baked', limit: { context: 64_000, output: 8_000 } } } }))

let picker: () => Response = () => Response.json({ models: { 'myendpoint/big': { name: 'Big', limit: { context: 1_048_576 } } } })
const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).searchParams.get('scope') === 'picker' ? picker() : new Response('no', { status: 404 })) })
afterAll(() => server.stop(true))

const env = (): NodeJS.ProcessEnv => ({
  KORTIX_LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
  KORTIX_TOKEN: 'tok',
  KORTIX_LLM_CATALOG_FILE: bakedFile,
  KORTIX_LLM_PROXY_DISABLE: '1',
})

test('pi sizes a model from the live picker catalog, which the baked file lacks', async () => {
  const models = await createPiModels({ env: env(), defaultModelRef: 'kortix/myendpoint/big' })
  const big = models.select('myendpoint/big').model
  expect(big.contextWindow).toBe(1_048_576)
  // No output limit reported: pi clamps max_tokens to the room left in the window.
  expect(big.maxTokens).toBe(1_048_576)
  expect(models.select('baked/model').model.contextWindow).toBe(64_000)
})

test('a dead picker keeps the baked catalog', async () => {
  picker = () => new Response('down', { status: 503 })
  const models = await createPiModels({ env: env(), defaultModelRef: 'kortix/baked/model' })
  expect(models.select('baked/model').model.contextWindow).toBe(64_000)
})

test('the compaction reserve is the model output limit, so the answer always has room', () => {
  const overrides = compactionSettings({
    'agent/big': { limit: { context: 128_000, output: 32_768 } },
    'agent/long-answer': { limit: { context: 200_000, output: 64_000 } },
    // A model that claims most of its window as output still compacts at half the window.
    'agent/greedy': { limit: { context: 1_048_576, output: 943_718 } },
    // pi's own default already covers a small output limit: no override.
    'agent/small': { limit: { context: 64_000, output: 8_000 } },
    // No output limit reported: pi caps the request at the window, so the reserve is capped too.
    'agent/window-only': { limit: { context: 1_048_576 } },
  }).modelOverrides
  expect(overrides).toEqual({
    'kortix/agent/big': { reserveTokens: 32_768 },
    'kortix/agent/long-answer': { reserveTokens: 64_000 },
    'kortix/agent/greedy': { reserveTokens: 524_288 },
    'kortix/agent/window-only': { reserveTokens: 524_288 },
  })
})
