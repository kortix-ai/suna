import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLED_MANAGED_MODELS,
  buildOpencodeConfigContent,
  fetchManagedModels,
  refreshGatewayCatalogFile,
  resetManagedModelsStateForTests,
  startManagedModelsPrefetch,
  withManagedOverlay,
} from '../opencode'

// The 2026-08-19 outage in one sentence: the image-baked catalog is frozen at
// template-build time, the managed lineup is deployment config, so a managed
// model added after the last build was absent from OpenCode's provider map and
// every turn on it died with `ModelNotFound: kortix/<id>` 2ms after the prompt.
// These tests pin the fix — the sandbox learns the managed set from the API it
// talks to, on every boot, and never falls below the bundled managed floor.

const GATEWAY = {
  KORTIX_WORKSPACE: '/workspace',
  KORTIX_LLM_BASE_URL: 'https://gw.kortix.test/v1',
  KORTIX_LLM_API_KEY: 'gw-key',
}

// A baked catalog that predates the managed-lineup change: it carries a BYOK
// model and exactly one managed model, missing the rest.
const STALE_BAKED = {
  models: {
    'openai/gpt-5.5': { name: 'GPT-5.5', provider: 'openai', limit: { context: 400_000 } },
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash (stale)', provider: 'kortix' },
  },
}

const LIVE_MANAGED = {
  models: {
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', provider: 'kortix' },
    'grok-4.6': { name: 'Grok 4.6', provider: 'kortix', limit: { context: 500_000 } },
    'new-managed-9.9': { name: 'New Managed 9.9', provider: 'kortix' },
  },
}

const realFetch = globalThis.fetch
const tempDirs: string[] = []

async function bakedCatalogFile(body: unknown = STALE_BAKED): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-managed-'))
  tempDirs.push(dir)
  const file = join(dir, 'catalog.json')
  await writeFile(file, JSON.stringify(body))
  return file
}

type ProviderConfig = { provider: { kortix: { models: Record<string, { name?: string }> } } }

function providerModels(raw: string | undefined): Record<string, { name?: string }> {
  return (JSON.parse(raw!) as ProviderConfig).provider.kortix.models
}

beforeEach(() => {
  resetManagedModelsStateForTests()
})

afterEach(async () => {
  globalThis.fetch = realFetch
  resetManagedModelsStateForTests()
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('managed listing fetch', () => {
  test('asks the gateway for the managed scope only', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string) => {
      urls.push(String(input))
      return new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
    }) as unknown as typeof fetch

    const models = await fetchManagedModels('https://gw.kortix.test/v1', 'k')

    expect(urls).toEqual(['https://gw.kortix.test/v1/models?scope=managed'])
    expect(Object.keys(models ?? {}).sort()).toEqual([
      'deepseek-v4-flash',
      'grok-4.6',
      'new-managed-9.9',
    ])
  })

  test('retries a failing gateway inside its budget, then gives up', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('nope', { status: 503 })
    }) as unknown as typeof fetch

    const started = Date.now()
    const models = await fetchManagedModels('https://gw.kortix.test/v1', 'k')

    expect(models).toBeNull()
    expect(calls).toBe(3)
    expect(Date.now() - started).toBeLessThan(5_500)
  })

  test('an empty managed set (free tier) is not an overlay', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: {} }), { status: 200 })) as unknown as typeof fetch

    expect(await fetchManagedModels('https://gw.kortix.test/v1', 'k')).toBeNull()
  })
})

describe('boot config composition', () => {
  test('a stale baked catalog is overlaid with the LIVE managed set', async () => {
    globalThis.fetch = (async (input: string) => {
      expect(String(input)).toContain('scope=managed')
      return new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
    }) as unknown as typeof fetch

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_LLM_API_KEY)
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
    } as NodeJS.ProcessEnv)
    const models = providerModels(raw)

    // The model the baked image never heard of is now registered.
    expect(models['grok-4.6']).toBeDefined()
    expect(models['new-managed-9.9']).toBeDefined()
    // Live data wins over the stale baked record for a managed id.
    expect(models['deepseek-v4-flash']?.name).toBe('DeepSeek V4 Flash')
    // BYOK models from the baked catalog are untouched.
    expect(models['openai/gpt-5.5']).toBeDefined()
  })

  test('a failed managed fetch still leaves the bundled managed floor', async () => {
    globalThis.fetch = (async () =>
      new Response('down', { status: 500 })) as unknown as typeof fetch

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_LLM_API_KEY)
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
    } as NodeJS.ProcessEnv)
    const models = providerModels(raw)

    for (const id of Object.keys(BUNDLED_MANAGED_MODELS)) {
      expect(models[id]).toBeDefined()
    }
    // Fill-only: the hand-maintained table never overwrites the baked record.
    expect(models['deepseek-v4-flash']?.name).toBe('DeepSeek V4 Flash (stale)')
    expect(models['openai/gpt-5.5']).toBeDefined()
  })

  test('a hanging gateway cannot hold the OpenCode spawn past the await cap', async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 60_000))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_LLM_API_KEY)
    const started = Date.now()
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
    } as NodeJS.ProcessEnv)
    const elapsed = Date.now() - started
    const models = providerModels(raw)

    expect(elapsed).toBeLessThan(4_000)
    // It waited for the in-flight answer rather than skipping it outright...
    expect(elapsed).toBeGreaterThan(1_500)
    // ...and fell back to the bundled floor instead of shipping a short picker.
    expect(models['grok-4.6']).toBeDefined()
  }, 15_000)

  test('with no prefetch started the boot path stays network-free', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string) => {
      calls.push(String(input))
      return new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
    }) as unknown as typeof fetch

    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
    } as NodeJS.ProcessEnv)

    expect(calls).toEqual([])
    expect(providerModels(raw)['grok-4.6']).toBeDefined()
  })
})

describe('warm-fork adoption refresh', () => {
  async function refreshWith(
    current: unknown,
    full: unknown,
    managed: unknown,
  ): Promise<{ changed: boolean; written: Record<string, unknown> }> {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-adopt-'))
    tempDirs.push(dir)
    const currentFile = join(dir, 'baked.json')
    const targetFile = join(dir, 'session.json')
    await writeFile(currentFile, JSON.stringify(current))
    globalThis.fetch = (async (input: string) =>
      new Response(JSON.stringify(String(input).includes('scope=managed') ? managed : full), {
        status: 200,
      })) as unknown as typeof fetch

    const result = await refreshGatewayCatalogFile({
      currentCatalogFile: currentFile,
      targetCatalogFile: targetFile,
      fetchBaseURL: GATEWAY.KORTIX_LLM_BASE_URL,
      fetchApiKey: GATEWAY.KORTIX_LLM_API_KEY,
    })
    const written = JSON.parse(await readFile(targetFile, 'utf8')) as {
      models: Record<string, unknown>
    }
    return { changed: !!result?.changed, written: written.models }
  }

  test('reports changed when only the MANAGED set differs', async () => {
    const full = { models: STALE_BAKED.models }
    const { changed, written } = await refreshWith(STALE_BAKED, full, LIVE_MANAGED)

    // The full catalog is byte-identical to the current file; the managed
    // overlay is the only difference — and it MUST still trip the controlled
    // OpenCode restart, because OpenCode reads providers at process start.
    expect(changed).toBe(true)
    expect(written['grok-4.6']).toBeDefined()
  })

  test('an unchanged catalog + unchanged managed set keeps the no-restart path', async () => {
    const composed = withManagedOverlay(STALE_BAKED.models, LIVE_MANAGED.models)
    const { changed } = await refreshWith(
      { models: composed },
      { models: STALE_BAKED.models },
      LIVE_MANAGED,
    )

    expect(changed).toBe(false)
  })

  test('a dead full-catalog fetch still lands the managed overlay on the session file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-adopt-'))
    tempDirs.push(dir)
    const currentFile = join(dir, 'baked.json')
    const targetFile = join(dir, 'session.json')
    await writeFile(currentFile, JSON.stringify(STALE_BAKED))
    globalThis.fetch = (async (input: string) =>
      String(input).includes('scope=managed')
        ? new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
        : new Response('boom', { status: 500 })) as unknown as typeof fetch

    const result = await refreshGatewayCatalogFile({
      currentCatalogFile: currentFile,
      targetCatalogFile: targetFile,
      fetchBaseURL: GATEWAY.KORTIX_LLM_BASE_URL,
      fetchApiKey: GATEWAY.KORTIX_LLM_API_KEY,
    })
    const written = JSON.parse(await readFile(targetFile, 'utf8')) as {
      models: Record<string, unknown>
    }

    expect(result?.changed).toBe(true)
    expect(written.models['grok-4.6']).toBeDefined()
    expect(written.models['openai/gpt-5.5']).toBeDefined()
  }, 20_000)
})

describe('withManagedOverlay', () => {
  test('a live managed set is authoritative for its ids and additive elsewhere', () => {
    const out = withManagedOverlay(
      { 'a/b': { name: 'B' }, 'grok-4.6': { name: 'old' } },
      { 'grok-4.6': { name: 'new' }, 'x-1': { name: 'X' } },
    )
    expect(out['grok-4.6']?.name).toBe('new')
    expect(out['a/b']?.name).toBe('B')
    expect(out['x-1']?.name).toBe('X')
  })

  test('without a live set the bundled managed models only fill gaps', () => {
    const out = withManagedOverlay({ 'grok-4.6': { name: 'baked' } }, null)
    expect(out['grok-4.6']?.name).toBe('baked')
    expect(out['deepseek-v4-flash']).toBeDefined()
  })

  test('never removes a model the disk catalog already carried', () => {
    const out = withManagedOverlay({ 'legacy/model': { name: 'L' } }, { 'grok-4.6': { name: 'G' } })
    expect(out['legacy/model']).toBeDefined()
  })
})
