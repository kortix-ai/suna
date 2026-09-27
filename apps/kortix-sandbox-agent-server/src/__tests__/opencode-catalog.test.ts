import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLED_MANAGED_MODELS,
  MINIMAL_FALLBACK_MODELS,
  buildOpencodeConfigContent,
  catalogIsDegraded,
  convergeManagedModelCatalog,
  fetchManagedModels,
  managedCatalogFallbackReason,
  managedModelIdsSnapshot,
  missingManagedModelIds,
  refreshGatewayCatalogFile,
  resetManagedModelsStateForTests,
  scheduleCatalogWarmToPathForTests,
  settleManagedModelsPrefetch,
  startManagedModelsPrefetch,
  type Opencode,
} from '../harness/open-code/lifecycle'
import { loadOpenCodeConfig as loadConfig } from '../harness/open-code/config'
import { reconcileManagedModels, resetManagedReconcileForTests } from '../harness/open-code/boot'

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
  test('asks the gateway for the picker scope only', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string) => {
      urls.push(String(input))
      return new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
    }) as unknown as typeof fetch

    const models = await fetchManagedModels('https://gw.kortix.test/v1', 'k')

    expect(urls).toEqual(['https://gw.kortix.test/v1/models?scope=picker'])
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

  test('an empty picker listing (free tier) still leaves every bundled managed model', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: {} }), { status: 200 })) as unknown as typeof fetch

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await settleManagedModelsPrefetch()
    const models = providerModels(
      await buildOpencodeConfigContent({
        ...GATEWAY,
        KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile(),
      } as NodeJS.ProcessEnv),
    )

    for (const id of Object.keys(BUNDLED_MANAGED_MODELS)) expect(models[id]).toBeDefined()
  })
})

describe('boot config composition', () => {
  test('a stale baked catalog is overlaid with the LIVE managed set once it is known', async () => {
    globalThis.fetch = (async (input: string) => {
      expect(String(input)).toContain('scope=picker')
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
    expect(models['deepseek-v4.1-flash']).toBeDefined()
    expect(models['openai/gpt-5.5']).toBeDefined()
  }, 15_000)

})

describe('the boot config never touches the network', () => {
  // `opencode serve` cannot bind until this config exists, so the build reads
  // only disk: a catalog file, else the bundled minimal set.
  const NO_FILE_ENV = {
    KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1',
    KORTIX_TOKEN: 'k-test',
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_LLM_CATALOG_FILE: join(tmpdir(), 'kortix-absent-catalog.json'),
  }

  function recordFetches(): string[] {
    const calls: string[] = []
    globalThis.fetch = (async (input: string) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    return calls
  }

  test('with no catalog file it falls back to the minimal model set, with no fetch', async () => {
    const calls = recordFetches()
    const models = providerModels(await buildOpencodeConfigContent(NO_FILE_ENV as NodeJS.ProcessEnv))
    expect(Object.keys(models)).toEqual(Object.keys(MINIMAL_FALLBACK_MODELS))
    expect(calls).toEqual([])
  })

  test('a catalog file is used verbatim plus the bundled managed floor, with no fetch', async () => {
    // Prod 2026-08-19: a baked catalog older than the managed lineup hid a
    // managed model from OpenCode. The bundled set fills the gap.
    const calls = recordFetches()
    const models = providerModels(
      await buildOpencodeConfigContent({
        ...NO_FILE_ENV,
        KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile({ models: { 'test/only-model': { name: 'Only Model' } } }),
      } as NodeJS.ProcessEnv),
    )
    expect(models['test/only-model']).toBeDefined()
    for (const id of Object.keys(BUNDLED_MANAGED_MODELS)) expect(models[id]).toBeDefined()
    expect(calls).toEqual([])
  })

  test('catalogIsDegraded is true with no file and false with one', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kortix-degraded-')), 'catalog.json')
    tempDirs.push(join(file, '..'))
    expect(catalogIsDegraded(file)).toBe(true)
    await writeFile(file, JSON.stringify({ models: { 'a/b': { name: 'B' } } }))
    expect(catalogIsDegraded(file)).toBe(false)
  })

  test('every model gets a context window: a known one by id tail, else the conservative default', async () => {
    // The gateway listing carries no limits; without one OpenCode cannot size
    // the conversation and auto-compaction never fires.
    const knownTail = Object.entries(MINIMAL_FALLBACK_MODELS).find(([, model]) => model.limit?.context)!
    const tail = knownTail[0].split('/').pop()!
    recordFetches()
    const models = providerModels(
      await buildOpencodeConfigContent({
        ...NO_FILE_ENV,
        KORTIX_LLM_CATALOG_FILE: await bakedCatalogFile({
          models: { [`other-provider/${tail}`]: { name: 'Known tail' }, 'unknown/model-x': { name: 'Unknown' } },
        }),
      } as NodeJS.ProcessEnv),
    ) as Record<string, { limit?: { context?: number; output?: number } }>
    expect(models[`other-provider/${tail}`]?.limit).toEqual(knownTail[1].limit)
    expect(models['unknown/model-x']?.limit).toEqual({ context: 200_000, output: 32_000 })
  })

  test('no OpenAI reasoning model in the fallback set claims temperature support', () => {
    // OpenCode would send `temperature` and every turn 400s while the fallback
    // set is in effect.
    const offenders = Object.entries(MINIMAL_FALLBACK_MODELS)
      .filter(([id, model]) => id.startsWith('openai/') && model.reasoning && model.temperature)
      .map(([id]) => id)
    expect(offenders).toEqual([])
  })
})

describe('a repaired catalog is rebuilt to a known shape before it reaches disk', () => {
  // The remote listing becomes OpenCode config. An unknown field once made
  // OpenCode reject its config at startup.
  async function warmThenRead(catalog: unknown): Promise<Record<string, any> | null> {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-warm-'))
    tempDirs.push(dir)
    const target = join(dir, 'llm-catalog.json')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: catalog }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    scheduleCatalogWarmToPathForTests(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN, target)
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(target, 'utf8')).models
      } catch {
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    return null
  }

  test.each([
    [
      'drops unrecognised fields',
      { 'a/b': { name: 'B', reasoning: true, arbitrary: { deep: 'junk' } } },
      { 'a/b': { name: 'B', reasoning: true } },
    ],
    ['rejects non-object entries', { 'good/one': { name: 'G' }, 'bad/one': 'not-an-object' }, { 'good/one': { name: 'G' } }],
    ['coerces a missing name to the id', { 'x/y': { reasoning: true } }, { 'x/y': { name: 'x/y', reasoning: true } }],
    [
      'keeps structured limit objects and drops a non-object cost',
      { 'm/1': { name: 'M', limit: { context: 1000 }, cost: 'free' } },
      { 'm/1': { name: 'M', limit: { context: 1000 } } },
    ],
  ])('%s', async (_name, served, expected) => {
    expect(await warmThenRead(served)).toEqual(expected)
  })
})

describe('warm-fork adoption refresh', () => {
  async function refreshWith(
    current: unknown,
    full: unknown,
    managed: unknown,
  ): Promise<{ changed: boolean; written: Record<string, unknown>; auth: Array<string | null> }> {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-adopt-'))
    tempDirs.push(dir)
    const currentFile = join(dir, 'baked.json')
    const targetFile = join(dir, 'session.json')
    await writeFile(currentFile, JSON.stringify(current))
    const auth: Array<string | null> = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'))
      return new Response(JSON.stringify(String(input).includes('scope=picker') ? managed : full), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const result = await refreshGatewayCatalogFile({
      currentCatalogFile: currentFile,
      targetCatalogFile: targetFile,
      fetchBaseURL: GATEWAY.KORTIX_LLM_BASE_URL,
      fetchApiKey: GATEWAY.KORTIX_TOKEN,
    })
    const written = JSON.parse(await readFile(targetFile, 'utf8')) as {
      models: Record<string, unknown>
    }
    return { changed: !!result?.changed, written: written.models, auth }
  }

  test('reports changed when only the MANAGED set differs', async () => {
    const full = { models: STALE_BAKED.models }
    const { changed, written, auth } = await refreshWith(STALE_BAKED, full, LIVE_MANAGED)

    // The full catalog is byte-identical to the current file; the managed
    // overlay is the only difference — and it MUST still trip the controlled
    // OpenCode restart, because OpenCode reads providers at process start.
    expect(changed).toBe(true)
    expect(written['grok-4.6']).toBeDefined()
    // Both reads authenticate with the session's own gateway key.
    expect(auth.length).toBeGreaterThan(0)
    expect(auth.every((value) => value === `Bearer ${GATEWAY.KORTIX_TOKEN}`)).toBe(true)
  })

  test('an unchanged catalog + unchanged managed set keeps the no-restart path', async () => {
    // The first refresh lands the overlay; a second one over its own output
    // has nothing left to change.
    const first = await refreshWith(STALE_BAKED, { models: STALE_BAKED.models }, LIVE_MANAGED)
    expect(first.changed).toBe(true)
    const second = await refreshWith(
      { models: first.written },
      { models: STALE_BAKED.models },
      LIVE_MANAGED,
    )

    expect(second.changed).toBe(false)
  })

  test('a dead full-catalog fetch still lands the managed overlay on the session file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-adopt-'))
    tempDirs.push(dir)
    const currentFile = join(dir, 'baked.json')
    const targetFile = join(dir, 'session.json')
    await writeFile(currentFile, JSON.stringify(STALE_BAKED))
    globalThis.fetch = (async (input: string) =>
      String(input).includes('scope=picker')
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
    expect(missingManagedModelIds(LIVE_MANAGED.models)).toContain('new-managed-9.9')

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

// The health-report freshness signal a wake/turn-start on a real dev box
// exposed as broken 2026-09-26: a box woken today still served the
// 2026-08-10 managed lineup (deepseek-v4-flash, glm-5.2, grok-4.6, …) instead
// of the current one (deepseek-v4.1-flash, glm-5.3-flash, kimi-k3) because
// nothing on ANY post-boot path re-fetched and re-applied the overlay.
describe('managed catalog health snapshot', () => {
  test('reports unconfirmed (null) before any live fetch ever succeeds', () => {
    expect(managedModelIdsSnapshot()).toBeNull()
    expect(managedCatalogFallbackReason()).toBeNull()
  })

  test('reports the live ids once a fetch succeeds, and clears any earlier failure', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch
    await fetchManagedModels(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    expect(managedCatalogFallbackReason()).not.toBeNull()

    globalThis.fetch = (async () =>
      new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch
    const live = await fetchManagedModels(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    expect(live).not.toBeNull()
    // `fetchManagedModels` alone does not publish to the cache — only the
    // prefetch/convergence callers that choose to remember it do.
    expect(managedModelIdsSnapshot()).toBeNull()

    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await settleManagedModelsPrefetch()
    expect(managedModelIdsSnapshot()?.sort()).toEqual(
      Object.keys(LIVE_MANAGED.models).sort(),
    )
    expect(managedCatalogFallbackReason()).toBeNull()
  })

  test('a failed boot fetch is visible on the health snapshot, not just a log line', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch
    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await settleManagedModelsPrefetch()

    expect(managedModelIdsSnapshot()).toBeNull()
    expect(managedCatalogFallbackReason()).toContain('servable models unavailable')
  })
})

describe('on-demand managed catalog converge (post-boot self-heal + wake/refresh)', () => {
  const cfg = loadConfig({ KORTIX_WORKSPACE: '/workspace' } as NodeJS.ProcessEnv)
  const REAL_CATALOG_ENV = process.env.KORTIX_LLM_CATALOG_FILE
  const REAL_BASE_URL = process.env.KORTIX_LLM_BASE_URL
  const REAL_TOKEN = process.env.KORTIX_TOKEN

  // `convergeManagedModelCatalog` reads gateway credentials off `process.env`
  // directly (it runs at arbitrary points in a session's life, not only at
  // the config build these fixtures otherwise pass an explicit env object
  // to) — so these tests need them SET on the real process env, not merely
  // passed as a parameter.
  beforeEach(() => {
    process.env.KORTIX_LLM_BASE_URL = GATEWAY.KORTIX_LLM_BASE_URL
    process.env.KORTIX_TOKEN = GATEWAY.KORTIX_TOKEN
  })

  afterEach(() => {
    if (REAL_CATALOG_ENV === undefined) delete process.env.KORTIX_LLM_CATALOG_FILE
    else process.env.KORTIX_LLM_CATALOG_FILE = REAL_CATALOG_ENV
    if (REAL_BASE_URL === undefined) delete process.env.KORTIX_LLM_BASE_URL
    else process.env.KORTIX_LLM_BASE_URL = REAL_BASE_URL
    if (REAL_TOKEN === undefined) delete process.env.KORTIX_TOKEN
    else process.env.KORTIX_TOKEN = REAL_TOKEN
  })

  async function targetPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-ondemand-'))
    tempDirs.push(dir)
    return join(dir, 'kortix-llm-catalog.session.json')
  }

  function fakeOpencode(swaps: { n: number }, opts: { swapOutcome?: 'swapped' | 'kept-old' } = {}): Opencode {
    return {
      getInternalUrl: () => 'http://127.0.0.1:65535',
      reloadVerified: async () => {
        if (opts.swapOutcome === 'kept-old') {
          return { outcome: 'kept-old', reason: 'the verified opencode exited before promotion' }
        }
        swaps.n++
        return { outcome: 'swapped', port: 4096, pid: 4242, turnEnded: false, orphanedMessageId: null }
      },
    } as unknown as Opencode
  }

  /** Boot on the STALE baked catalog (matches `lastConfiguredProviderModelIds`
   *  to what a real box's running OpenCode has), WITHOUT settling any
   *  prefetch — so the on-demand converge is the first thing to ever see the
   *  live lineup. This is the real dev-box shape: boot happened hours ago, the
   *  prefetch/cache is long cold, and only a fresh fetch can tell the truth. */
  async function bootOnStaleCatalogOnly(): Promise<void> {
    process.env.KORTIX_LLM_CATALOG_FILE = await bakedCatalogFile()
    await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: process.env.KORTIX_LLM_CATALOG_FILE,
    } as NodeJS.ProcessEnv)
  }

  test('fetches fresh (never the stale boot prefetch) and restarts when a managed id is missing', async () => {
    await bootOnStaleCatalogOnly()
    // Confirms the fixture: the config just booted with does NOT have these.
    expect(missingManagedModelIds(LIVE_MANAGED.models).sort()).toEqual(['grok-4.6', 'new-managed-9.9'])

    globalThis.fetch = (async (input: string) => {
      expect(String(input)).toContain('scope=picker')
      return new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })
    }) as unknown as typeof fetch

    const swaps = { n: 0 }
    const target = await targetPath()
    const result = await convergeManagedModelCatalog(fakeOpencode(swaps), cfg, {
      catalogTargetFile: target,
      turnProbe: async () => false,
    })

    expect(result.outcome).toBe('restarted')
    expect(result.missing.sort()).toEqual(['grok-4.6', 'new-managed-9.9'])
    expect(swaps.n).toBe(1)
    const written = JSON.parse(await readFile(target, 'utf8')) as { models: Record<string, unknown> }
    expect(written.models['grok-4.6']).toBeDefined()
    expect(written.models['new-managed-9.9']).toBeDefined()
    // The health snapshot is now confirmed against the live lineup too.
    expect(managedModelIdsSnapshot()?.sort()).toEqual(Object.keys(LIVE_MANAGED.models).sort())
  })

  test('allowRestart:false updates the file but never touches the running OpenCode', async () => {
    await bootOnStaleCatalogOnly()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch

    const swaps = { n: 0 }
    const target = await targetPath()
    const result = await convergeManagedModelCatalog(fakeOpencode(swaps), cfg, {
      allowRestart: false,
      catalogTargetFile: target,
      turnProbe: async () => false,
    })

    expect(result.outcome).toBe('file-updated')
    expect(swaps.n).toBe(0)
    const written = JSON.parse(await readFile(target, 'utf8')) as { models: Record<string, unknown> }
    expect(written.models['new-managed-9.9']).toBeDefined()
  })

  test('reports unchanged and touches nothing when every managed id is already registered', async () => {
    process.env.KORTIX_LLM_CATALOG_FILE = await bakedCatalogFile()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch
    // The config was built AFTER the live set was already known, so it has
    // every managed id — the state a fully-current box is in.
    startManagedModelsPrefetch(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_TOKEN)
    await settleManagedModelsPrefetch()
    await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: process.env.KORTIX_LLM_CATALOG_FILE,
    } as NodeJS.ProcessEnv)
    expect(missingManagedModelIds(LIVE_MANAGED.models)).toEqual([])

    const swaps = { n: 0 }
    const target = await targetPath()
    const result = await convergeManagedModelCatalog(fakeOpencode(swaps), cfg, {
      catalogTargetFile: target,
      turnProbe: async () => false,
    })

    expect(result.outcome).toBe('unchanged')
    expect(result.missing).toEqual([])
    expect(swaps.n).toBe(0)
    expect(await readFile(target, 'utf8').catch(() => null)).toBeNull()
  })

  test('never restarts across a live turn — or one it cannot read', async () => {
    for (const turnInFlight of [true, null] as const) {
      resetManagedModelsStateForTests()
      await bootOnStaleCatalogOnly()
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch

      const swaps = { n: 0 }
      const target = await targetPath()
      const result = await convergeManagedModelCatalog(fakeOpencode(swaps), cfg, {
        catalogTargetFile: target,
        turnProbe: async () => turnInFlight,
      })

      expect(result.outcome).toBe('declined')
      expect(swaps.n).toBe(0)
      // The overlay is still written — the file update never waits on the
      // idle check, only the restart does.
      const written = JSON.parse(await readFile(target, 'utf8')) as { models: Record<string, unknown> }
      expect(written.models['new-managed-9.9']).toBeDefined()
    }
  })

  test('a verified swap that declines to boot is reported, not swallowed', async () => {
    await bootOnStaleCatalogOnly()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(LIVE_MANAGED), { status: 200 })) as unknown as typeof fetch

    const swaps = { n: 0 }
    const target = await targetPath()
    const result = await convergeManagedModelCatalog(
      fakeOpencode(swaps, { swapOutcome: 'kept-old' }),
      cfg,
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    expect(result.outcome).toBe('declined')
    expect(result.reason).toContain('exited before promotion')
  })

  test('reports no-gateway when this box has no gateway credentials, without throwing', async () => {
    const realBaseUrl = process.env.KORTIX_LLM_BASE_URL
    const realToken = process.env.KORTIX_TOKEN
    delete process.env.KORTIX_LLM_BASE_URL
    delete process.env.KORTIX_TOKEN
    try {
      const swaps = { n: 0 }
      const result = await convergeManagedModelCatalog(fakeOpencode(swaps), cfg, {
        turnProbe: async () => false,
      })
      expect(result.outcome).toBe('no-gateway')
      expect(swaps.n).toBe(0)
    } finally {
      if (realBaseUrl !== undefined) process.env.KORTIX_LLM_BASE_URL = realBaseUrl
      if (realToken !== undefined) process.env.KORTIX_TOKEN = realToken
    }
  })
})
