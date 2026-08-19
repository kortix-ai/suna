import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildOpencodeConfigContent,
  configuredProviderModelIds,
  connectedProviderIds,
  missingPickerModelIds,
  modelNotFoundId,
  pickerRelevantModelIds,
  resetManagedModelsStateForTests,
  type Opencode,
} from '../opencode'
import { loadConfig } from '../config'
import {
  reconcileSelectableModelsAtBoot,
  registerModelReconcile,
  resetBootReconcileForTests,
  resetModelReconcileForTests,
  scheduleModelReconcile,
  selfHealMissingModel,
  startCatalogPrefetches,
} from '../model-reconcile'

// ============================================================================
// The SELECTABLE-SET reconcile.
//
// The 2026-08-19 outage was the managed half of one defect: OpenCode reads its
// provider models once, at process start, from a catalog baked into the sandbox
// image — and both the managed lineup (deployment config) and models.dev (~60
// new models a day) move faster than that image. A model the picker offers but
// the provider map lacks dies with `ModelNotFound: kortix/<id>` 2ms after the
// prompt.
//
// The BYOK half is what self-host hits: there is no managed lineup there at all
// (`KORTIX_MANAGED_PROVIDER_ENABLED=false`), every model is a connected
// provider's, and the same stale file produces the same error.
//
// The fix must hold BOTH ways without restarting every boot. That is the whole
// reason the diff is scoped to `managed ∪ connected-provider models` instead of
// the ~6k-model catalog: a day-old baked file is ALWAYS missing something
// nobody can pick.
// ============================================================================

const GATEWAY = {
  KORTIX_WORKSPACE: '/workspace',
  KORTIX_LLM_BASE_URL: 'https://gw.kortix.test/v1',
  KORTIX_LLM_API_KEY: 'gw-key',
}

/** A baked catalog frozen before both the managed change and the models.dev adds. */
const STALE_BAKED = {
  models: {
    'anthropic/claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    'openai/gpt-5.5': { name: 'GPT-5.5', provider: 'openai' },
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash (stale)', provider: 'kortix' },
  },
}

/** What the gateway serves today: one new managed model, and models.dev's new
 *  entries for THREE providers — only one of which this project connected. */
const LIVE_MANAGED = {
  models: {
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', provider: 'kortix' },
    'grok-4.6': { name: 'Grok 4.6', provider: 'kortix' },
  },
}
const LIVE_FULL = {
  models: {
    ...STALE_BAKED.models,
    ...LIVE_MANAGED.models,
    // CONNECTED provider, new since the bake → must be registered.
    'anthropic/claude-opus-4-9': { name: 'Claude Opus 4.9', provider: 'anthropic' },
    // NOT connected → must NOT buy a restart, however new it is.
    'openai/gpt-6': { name: 'GPT-6', provider: 'openai' },
    'mistral/large-3': { name: 'Mistral Large 3', provider: 'mistral' },
  },
}

const realFetch = globalThis.fetch
const realConnected = process.env.KORTIX_LLM_CONNECTED_PROVIDERS
const realCatalogEnv = process.env.KORTIX_LLM_CATALOG_FILE
const realBaseUrl = process.env.KORTIX_LLM_BASE_URL
const realApiKey = process.env.KORTIX_LLM_API_KEY
const tempDirs: string[] = []
const cfg = loadConfig({ KORTIX_WORKSPACE: '/workspace' } as NodeJS.ProcessEnv)

async function tempFile(name: string, body?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-selectable-'))
  tempDirs.push(dir)
  const file = join(dir, name)
  if (body !== undefined) await writeFile(file, JSON.stringify(body))
  return file
}

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

/** Serve the managed + full catalogs the way the real gateway does. */
function serveGateway(managed: unknown, full: unknown, seen?: string[]): void {
  globalThis.fetch = (async (input: string) => {
    const url = String(input)
    seen?.push(url)
    return new Response(JSON.stringify(url.includes('scope=managed') ? managed : full), {
      status: 200,
    })
  }) as unknown as typeof fetch
}

/** Boot exactly as production does: prefetches in flight, config built WITHOUT
 *  waiting for either, so the running OpenCode holds only the baked catalog. */
async function boot(catalogFile: string): Promise<void> {
  process.env.KORTIX_LLM_CATALOG_FILE = catalogFile
  // The self-heal path reads the gateway credentials off the daemon's own env,
  // exactly as a real sandbox does.
  process.env.KORTIX_LLM_BASE_URL = GATEWAY.KORTIX_LLM_BASE_URL
  process.env.KORTIX_LLM_API_KEY = GATEWAY.KORTIX_LLM_API_KEY
  startCatalogPrefetches(GATEWAY as unknown as NodeJS.ProcessEnv)
  await buildOpencodeConfigContent({
    ...GATEWAY,
    KORTIX_LLM_CATALOG_FILE: catalogFile,
  } as NodeJS.ProcessEnv)
}

beforeEach(() => {
  resetManagedModelsStateForTests()
  resetBootReconcileForTests()
  resetModelReconcileForTests()
  delete process.env.KORTIX_LLM_CONNECTED_PROVIDERS
})

afterEach(async () => {
  globalThis.fetch = realFetch
  resetManagedModelsStateForTests()
  resetBootReconcileForTests()
  resetModelReconcileForTests()
  if (realConnected === undefined) delete process.env.KORTIX_LLM_CONNECTED_PROVIDERS
  else process.env.KORTIX_LLM_CONNECTED_PROVIDERS = realConnected
  if (realCatalogEnv === undefined) delete process.env.KORTIX_LLM_CATALOG_FILE
  else process.env.KORTIX_LLM_CATALOG_FILE = realCatalogEnv
  if (realBaseUrl === undefined) delete process.env.KORTIX_LLM_BASE_URL
  else process.env.KORTIX_LLM_BASE_URL = realBaseUrl
  if (realApiKey === undefined) delete process.env.KORTIX_LLM_API_KEY
  else process.env.KORTIX_LLM_API_KEY = realApiKey
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('connected-provider list', () => {
  test('parses the API-injected env var, case- and whitespace-tolerantly', () => {
    expect([
      ...connectedProviderIds({
        KORTIX_LLM_CONNECTED_PROVIDERS: ' Anthropic , openrouter,, codex ',
      } as NodeJS.ProcessEnv),
    ]).toEqual(['anthropic', 'openrouter', 'codex'])
  })

  test('an unset or empty var means managed-only, never "everything"', () => {
    expect(connectedProviderIds({} as NodeJS.ProcessEnv).size).toBe(0)
    expect(connectedProviderIds({ KORTIX_LLM_CONNECTED_PROVIDERS: '' } as NodeJS.ProcessEnv).size).toBe(0)
  })
})

describe('the reconcile set is managed ∪ connected BYOK — never the whole catalog', () => {
  test('picker-relevant ids exclude every unconnected provider', () => {
    const ids = pickerRelevantModelIds(
      LIVE_MANAGED.models,
      LIVE_FULL.models,
      new Set(['anthropic']),
    ).sort()

    expect(ids).toEqual([
      'anthropic/claude-opus-4-9',
      'anthropic/claude-sonnet-4-6',
      'deepseek-v4-flash',
      'grok-4.6',
    ])
    // The live catalog carries these and the picker cannot offer them.
    expect(ids).not.toContain('openai/gpt-6')
    expect(ids).not.toContain('mistral/large-3')
  })

  test('a bare id is only relevant when the LIVE managed listing carries it', () => {
    // A self-host gateway serves no managed models. A bare id left over in a
    // stale baked catalog is not selectable and must never buy a restart.
    expect(pickerRelevantModelIds({}, { 'legacy-managed-id': { name: 'Legacy' } }, new Set())).toEqual(
      [],
    )
  })
})

describe('boot reconcile', () => {
  test('a stale baked file missing a CONNECTED provider model → exactly one restart', async () => {
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway(LIVE_MANAGED, LIVE_FULL)
    await boot(await tempFile('baked.json', STALE_BAKED))
    expect(configuredProviderModelIds()?.has('anthropic/claude-opus-4-9')).toBe(false)

    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    const marks: string[] = []
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await reconcileSelectableModelsAtBoot((m) => marks.push(m))
    // Once per process, whatever calls it (seed boot then fork adoption).
    await reconcileSelectableModelsAtBoot((m) => marks.push(m))

    expect(restarts.n).toBe(1)
    expect(marks).toEqual(['managed-reconcile'])
    const written = (JSON.parse(await readFile(target, 'utf8')) as {
      models: Record<string, unknown>
    }).models
    // The new BYOK model AND the new managed model are registered...
    expect(written['anthropic/claude-opus-4-9']).toBeDefined()
    expect(written['grok-4.6']).toBeDefined()
    // ...the baked entries survive...
    expect(written['openai/gpt-5.5']).toBeDefined()
    // ...and nothing from an unconnected provider was pulled in.
    expect(written['openai/gpt-6']).toBeUndefined()
    expect(written['mistral/large-3']).toBeUndefined()
    expect(process.env.KORTIX_LLM_CATALOG_FILE).toBe(target)
  })

  test('the SAME stale file with the provider NOT connected → no restart at all', async () => {
    // models.dev added anthropic/claude-opus-4-9 and openai/gpt-6 since the
    // bake. Neither provider is connected, so neither is selectable, so the
    // reconcile must be a no-op. This is the case that would otherwise restart
    // every single boot forever.
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = ''
    serveGateway({ models: { 'deepseek-v4-flash': STALE_BAKED.models['deepseek-v4-flash'] } }, LIVE_FULL)
    await boot(await tempFile('baked.json', STALE_BAKED))

    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )
    await reconcileSelectableModelsAtBoot(() => {})

    expect(restarts.n).toBe(0)
    expect(await readFile(target, 'utf8').catch(() => null)).toBeNull()
  })

  test('a live turn defers the restart instead of severing it', async () => {
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway(LIVE_MANAGED, LIVE_FULL)
    await boot(await tempFile('baked.json', STALE_BAKED))

    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    let busy = true
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => busy },
    )

    await reconcileSelectableModelsAtBoot(() => {})
    expect(restarts.n).toBe(0)

    // The turn ends; the same reconcile now lands.
    busy = false
    await scheduleModelReconcile('turn-end')
    expect(restarts.n).toBe(1)
  })
})

describe('self-host: an explicitly empty managed listing', () => {
  test('does not inject the bundled managed floor', async () => {
    // KORTIX_MANAGED_PROVIDER_ENABLED=false ⇒ HTTP 200 `{"models":{}}`.
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway({ models: {} }, { models: STALE_BAKED.models })
    const catalogFile = await tempFile('baked.json', {
      models: { 'anthropic/claude-sonnet-4-6': { name: 'Claude Sonnet 4.6' } },
    })
    startCatalogPrefetches(GATEWAY as unknown as NodeJS.ProcessEnv)
    // Settle the managed prefetch first, so the config build sees the ANSWER.
    await new Promise((r) => setTimeout(r, 20))
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY,
      KORTIX_LLM_CATALOG_FILE: catalogFile,
    } as NodeJS.ProcessEnv)
    const models = (
      JSON.parse(raw!) as { provider: { kortix: { models: Record<string, unknown> } } }
    ).provider.kortix.models

    // Not one bundled managed id. Every one of them would 404 at a self-host
    // gateway that serves no managed lineup.
    expect(models['grok-4.6']).toBeUndefined()
    expect(models['deepseek-v4-flash']).toBeUndefined()
    // The project's own BYOK model is untouched.
    expect(models['anthropic/claude-sonnet-4-6']).toBeDefined()
  })

  test('and it reconciles to a no-op rather than restarting on phantom ids', async () => {
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway({ models: {} }, { models: STALE_BAKED.models })
    await boot(await tempFile('baked.json', STALE_BAKED))

    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )
    await reconcileSelectableModelsAtBoot(() => {})

    expect(restarts.n).toBe(0)
  })
})

describe('ModelNotFound self-heal', () => {
  test('parses the id out of both the raw and the rendered error shapes', () => {
    // The wire shape observed in prod 2026-08-19.
    expect(
      modelNotFoundId({ name: 'UnknownError', message: 'ModelNotFound: kortix/grok-4.6' }),
    ).toBe('grok-4.6')
    // The copy the UI rendered.
    expect(
      modelNotFoundId({ message: 'Model not found: kortix/grok-4.6. Did you mean: grok-4' }),
    ).toBe('grok-4.6')
    // A BYOK id keeps its provider prefix.
    expect(
      modelNotFoundId({ message: 'ModelNotFound: kortix/anthropic/claude-opus-4-9' }),
    ).toBe('anthropic/claude-opus-4-9')
    // Every other turn error is left alone.
    expect(modelNotFoundId({ name: 'APIError', message: 'Insufficient credits' })).toBeNull()
    expect(modelNotFoundId(undefined)).toBeNull()
  })

  test('registers the refused model and restarts once, so the NEXT send works', async () => {
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway(LIVE_MANAGED, LIVE_FULL)
    await boot(await tempFile('baked.json', STALE_BAKED))

    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    const healed = await selfHealMissingModel({
      name: 'UnknownError',
      message: 'ModelNotFound: kortix/grok-4.6',
    })

    expect(healed).toBe(true)
    expect(restarts.n).toBe(1)
    const written = (JSON.parse(await readFile(target, 'utf8')) as {
      models: Record<string, unknown>
    }).models
    expect(written['grok-4.6']).toBeDefined()

    // Rate-limited: a second identical error inside the cooldown must not buy a
    // second restart, or a genuinely unservable id turns every send into one.
    const again = await selfHealMissingModel({ message: 'ModelNotFound: kortix/grok-4.6' })
    expect(again).toBe(false)
    expect(restarts.n).toBe(1)
  })

  test('does nothing when the gateway does not serve that model either', async () => {
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway(LIVE_MANAGED, LIVE_FULL)
    await boot(await tempFile('baked.json', STALE_BAKED))

    const restarts = { n: 0 }
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: await tempFile('session.json'), turnProbe: async () => false },
    )

    expect(await selfHealMissingModel({ message: 'ModelNotFound: kortix/does-not-exist' })).toBe(
      false,
    )
    expect(restarts.n).toBe(0)
  })

  test('never restarts across a turn it cannot read', async () => {
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    serveGateway(LIVE_MANAGED, LIVE_FULL)
    await boot(await tempFile('baked.json', STALE_BAKED))

    const restarts = { n: 0 }
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: await tempFile('session.json'), turnProbe: async () => null },
    )

    expect(await selfHealMissingModel({ message: 'ModelNotFound: kortix/grok-4.6' })).toBe(false)
    expect(restarts.n).toBe(0)
  })
})

describe('missingPickerModelIds', () => {
  test('is empty before any config has been built (nothing to compare against)', () => {
    resetManagedModelsStateForTests()
    expect(missingPickerModelIds(LIVE_MANAGED.models, LIVE_FULL.models, new Set(['anthropic']))).toEqual(
      [],
    )
  })
})
