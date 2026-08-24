import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLED_MANAGED_MODELS,
  buildOpencodeConfigContent,
  configuredProviderModelIds,
  fetchManagedModels,
  missingManagedModelIds,
  refreshGatewayCatalogFile,
  resetManagedModelsStateForTests,
  settleManagedModelsPrefetch,
  startManagedModelsPrefetch,
  withManagedOverlay,
  type Opencode,
} from '../opencode'
import { loadConfig } from '../config'
import { reconcileManagedModels, resetManagedReconcileForTests } from '../main'

// The 2026-08-19 outage in one sentence: the image-baked catalog is frozen at
// template-build time, the managed lineup is deployment config, so a managed
// model added after the last build was absent from OpenCode's provider map and
// every turn on it died with `ModelNotFound: kortix/<id>` 2ms after the prompt.
// These tests pin the fix AND its cost model: the boot config never waits on
// the network (waiting cost 1.6s of a 6.5s dev boot), and the live answer is
// applied after the spawn — one controlled restart, only when a managed model
// is genuinely missing.

const GATEWAY = {
  KORTIX_WORKSPACE: '/workspace',
  KORTIX_LLM_BASE_URL: 'https://gw.kortix.test/v1',
  KORTIX_TOKEN: 'gw-key',
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
  resetManagedReconcileForTests()
})

afterEach(async () => {
  globalThis.fetch = realFetch
  resetManagedModelsStateForTests()
  resetManagedReconcileForTests()
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
  test('a stale baked catalog is overlaid with the LIVE managed set once it is known', async () => {
    globalThis.fetch = (async (input: string) => {
      expect(String(input)).toContain('scope=managed')
      return new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
    }) as unknown as typeof fetch

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    // Cached by the post-spawn reconcile; every later config build (the
    // reconcile's own restart, any restart after it) reads it synchronously.
    await settleManagedModelsPrefetch()
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

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
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

  // THE latency regression this design exists to prevent. `opencode serve`
  // cannot bind its port until this config is written, so the build must never
  // wait on a fetch — a hanging gateway has to cost ~0ms, not the fetch budget.
  test('a hanging gateway costs the config build no time at all', async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 60_000))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const file = await bakedCatalogFile()
    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    const started = Date.now()
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: file,
    } as NodeJS.ProcessEnv)
    const elapsed = Date.now() - started
    const models = providerModels(raw)

    expect(elapsed).toBeLessThan(50)
    // The bundled floor still ships, so the picker is never short.
    expect(models['grok-4.6']).toBeDefined()
    expect(models['openai/gpt-5.5']).toBeDefined()
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
      fetchApiKey: GATEWAY.KORTIX_TOKEN,
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
      fetchApiKey: GATEWAY.KORTIX_TOKEN,
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

describe('post-spawn managed reconcile', () => {
  const REAL_CATALOG_ENV = process.env.KORTIX_LLM_CATALOG_FILE

  afterEach(() => {
    if (REAL_CATALOG_ENV === undefined) delete process.env.KORTIX_LLM_CATALOG_FILE
    else process.env.KORTIX_LLM_CATALOG_FILE = REAL_CATALOG_ENV
  })

  function fakeOpencode(restarts: { n: number }): Opencode {
    return {
      getInternalUrl: () => 'http://127.0.0.1:65535',
      // waitForOpencodeReady short-circuits on 'ok', so the fake never polls.
      getState: () => 'ok',
      markReady: () => {},
      restart: async () => {
        restarts.n++
      },
    } as unknown as Opencode
  }

  const cfg = loadConfig({ KORTIX_WORKSPACE: '/workspace' } as NodeJS.ProcessEnv)

  async function targetPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-reconcile-'))
    tempDirs.push(dir)
    return join(dir, 'kortix-llm-catalog.session.json')
  }

  /** Boot exactly as production does: prefetch in flight, config built WITHOUT
   *  waiting for it — so the running OpenCode has only the bundled managed set. */
  async function bootWithLiveGateway(): Promise<void> {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch
    process.env.KORTIX_LLM_CATALOG_FILE = await bakedCatalogFile()
    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: process.env.KORTIX_LLM_CATALOG_FILE,
    } as NodeJS.ProcessEnv)
  }

  test('restarts opencode EXACTLY ONCE when the live set has a model the boot config lacks', async () => {
    await bootWithLiveGateway()
    // The provider map OpenCode booted with does not know the new model.
    expect(configuredProviderModelIds()?.has('new-managed-9.9')).toBe(false)

    const restarts = { n: 0 }
    const marks: string[] = []
    const target = await targetPath()
    const opts = { catalogTargetFile: target, turnProbe: async () => false }

    await reconcileManagedModels(fakeOpencode(restarts), cfg, (m) => marks.push(m), opts)
    // Single-flight: a second call must never buy a second restart.
    await reconcileManagedModels(fakeOpencode(restarts), cfg, (m) => marks.push(m), opts)

    expect(restarts.n).toBe(1)
    expect(marks).toEqual(['managed-reconcile'])
    // The overlay is on disk, and the next spawn reads it.
    const written = JSON.parse(await readFile(target, 'utf8')) as {
      models: Record<string, unknown>
    }
    expect(written.models['new-managed-9.9']).toBeDefined()
    expect(written.models['openai/gpt-5.5']).toBeDefined()
    expect(process.env.KORTIX_LLM_CATALOG_FILE).toBe(target)
  })

  test('does nothing when the boot config already has every managed model', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch
    process.env.KORTIX_LLM_CATALOG_FILE = await bakedCatalogFile()
    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await settleManagedModelsPrefetch()
    await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: process.env.KORTIX_LLM_CATALOG_FILE,
    } as NodeJS.ProcessEnv)

    const restarts = { n: 0 }
    const marks: string[] = []
    const target = await targetPath()
    await reconcileManagedModels(fakeOpencode(restarts), cfg, (m) => marks.push(m), {
      catalogTargetFile: target,
      turnProbe: async () => false,
    })

    expect(missingManagedModelIds(LIVE_MANAGED.models)).toEqual([])
    expect(restarts.n).toBe(0)
    expect(marks).toEqual(['managed-reconcile'])
    expect(await readFile(target, 'utf8').catch(() => null)).toBeNull()
  })

  test('never restarts across a live turn — or one it cannot read', async () => {
    for (const turnInFlight of [true, null] as const) {
      resetManagedModelsStateForTests()
      resetManagedReconcileForTests()
      await bootWithLiveGateway()

      const restarts = { n: 0 }
      const target = await targetPath()
      await reconcileManagedModels(fakeOpencode(restarts), cfg, () => {}, {
        catalogTargetFile: target,
        turnProbe: async () => turnInFlight,
      })

      expect(restarts.n).toBe(0)
      expect(await readFile(target, 'utf8').catch(() => null)).toBeNull()
    }
  })

  test('is a no-op when the gateway never answers (bundled managed set stands)', async () => {
    globalThis.fetch = (async () =>
      new Response('down', { status: 500 })) as unknown as typeof fetch
    process.env.KORTIX_LLM_CATALOG_FILE = await bakedCatalogFile()
    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: process.env.KORTIX_LLM_CATALOG_FILE,
    } as NodeJS.ProcessEnv)

    const restarts = { n: 0 }
    const target = await targetPath()
    await reconcileManagedModels(fakeOpencode(restarts), cfg, () => {}, {
      catalogTargetFile: target,
      turnProbe: async () => false,
    })

    expect(restarts.n).toBe(0)
  }, 15_000)
})
