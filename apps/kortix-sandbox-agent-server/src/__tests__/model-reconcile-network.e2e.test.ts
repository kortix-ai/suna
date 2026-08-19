/**
 * REAL-NETWORK proof of the selectable-model reconcile.
 *
 * Everything else in this suite stubs `globalThis.fetch`. This file does not:
 * it starts a real HTTP server on loopback that answers `/models` and
 * `/models?scope=managed` exactly as the gateway does — including the GZIP the
 * gateway now serves — and drives the daemon's real fetch/settle/diff/restart
 * path against it. That is the only way to prove the two halves actually fit:
 * a gzipped body must round-trip through Bun's transparent decompression into
 * the same provider map the reconcile diffs.
 *
 * The four cases are the four outcomes that matter in production:
 *   1. a stale baked file missing a CONNECTED provider's model → one restart;
 *   2. the same file when that provider is NOT connected        → no restart;
 *   3. `ModelNotFound` after the fact                            → self-heal;
 *   4. an explicitly EMPTY managed listing (self-host)           → no floor.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildOpencodeConfigContent,
  resetManagedModelsStateForTests,
  type Opencode,
} from '../opencode'
import { loadConfig } from '../config'
import {
  reconcileSelectableModelsAtBoot,
  registerModelReconcile,
  resetBootReconcileForTests,
  resetModelReconcileForTests,
  selfHealMissingModel,
  startCatalogPrefetches,
} from '../model-reconcile'

const cfg = loadConfig({ KORTIX_WORKSPACE: '/workspace' } as NodeJS.ProcessEnv)

/** A baked catalog frozen before the last managed change and the last models.dev sync. */
const STALE_BAKED = {
  models: {
    'anthropic/claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    'openai/gpt-5.5': { name: 'GPT-5.5', provider: 'openai' },
  },
}

const MANAGED_NOW = {
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', provider: 'kortix' },
  'grok-4.6': { name: 'Grok 4.6', provider: 'kortix' },
}

/** The live catalog: the baked entries, the managed lineup, and two models
 *  models.dev added AFTER the bake — one on a provider this project connected,
 *  one on a provider it did not. */
const FULL_NOW = {
  ...STALE_BAKED.models,
  ...MANAGED_NOW,
  'anthropic/claude-opus-4-9': { name: 'Claude Opus 4.9', provider: 'anthropic' },
  'openai/gpt-6': { name: 'GPT-6', provider: 'openai' },
}

type GatewayState = { managed: Record<string, unknown>; full: Record<string, unknown> }

const state: GatewayState = { managed: { ...MANAGED_NOW }, full: { ...FULL_NOW } }
const requests: string[] = []

/** The gateway, for real, over loopback — gzipping exactly like the shipped one. */
const gateway = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    requests.push(`${url.pathname}${url.search}`)
    if (!req.headers.get('authorization')?.startsWith('Bearer ')) {
      return new Response('unauthorized', { status: 401 })
    }
    const models = url.searchParams.get('scope') === 'managed' ? state.managed : state.full
    const body = JSON.stringify({ models })
    const acceptsGzip = /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'cache-control': 'private, max-age=60',
      vary: 'accept-encoding',
    }
    if (!acceptsGzip) return new Response(body, { headers })
    return new Response(new Response(body).body!.pipeThrough(new CompressionStream('gzip')), {
      headers: { ...headers, 'content-encoding': 'gzip' },
    })
  },
})

const GATEWAY_ENV = {
  KORTIX_WORKSPACE: '/workspace',
  KORTIX_LLM_BASE_URL: `http://127.0.0.1:${gateway.port}`,
  KORTIX_LLM_API_KEY: 'sandbox-key',
} as unknown as NodeJS.ProcessEnv

afterAll(() => gateway.stop(true))

const tempDirs: string[] = []
const realConnected = process.env.KORTIX_LLM_CONNECTED_PROVIDERS
const realCatalogEnv = process.env.KORTIX_LLM_CATALOG_FILE
const realBaseUrl = process.env.KORTIX_LLM_BASE_URL
const realApiKey = process.env.KORTIX_LLM_API_KEY

async function tempFile(name: string, body?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-net-reconcile-'))
  tempDirs.push(dir)
  const file = join(dir, name)
  if (body !== undefined) await writeFile(file, JSON.stringify(body))
  return file
}

function fakeOpencode(restarts: { n: number }): Opencode {
  return {
    getInternalUrl: () => 'http://127.0.0.1:65535',
    getState: () => 'ok',
    markReady: () => {},
    restart: async () => {
      restarts.n++
    },
  } as unknown as Opencode
}

/** Production boot order: prefetches started at proxy-up, config built without
 *  waiting for either, reconcile after the spawn. */
async function bootAgainstGateway(connected: string): Promise<{ catalogFile: string }> {
  process.env.KORTIX_LLM_CONNECTED_PROVIDERS = connected
  // The self-heal path reads the gateway credentials off the daemon's own env,
  // exactly as a real sandbox does.
  process.env.KORTIX_LLM_BASE_URL = GATEWAY_ENV.KORTIX_LLM_BASE_URL
  process.env.KORTIX_LLM_API_KEY = GATEWAY_ENV.KORTIX_LLM_API_KEY
  const catalogFile = await tempFile('baked.json', STALE_BAKED)
  process.env.KORTIX_LLM_CATALOG_FILE = catalogFile
  startCatalogPrefetches(GATEWAY_ENV)
  await buildOpencodeConfigContent({
    ...GATEWAY_ENV,
    KORTIX_LLM_CATALOG_FILE: catalogFile,
  } as NodeJS.ProcessEnv)
  return { catalogFile }
}

beforeEach(() => {
  requests.length = 0
  state.managed = { ...MANAGED_NOW }
  state.full = { ...FULL_NOW }
  resetManagedModelsStateForTests()
  resetBootReconcileForTests()
  resetModelReconcileForTests()
})

afterEach(async () => {
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

describe('reconcile against a REAL gateway over loopback', () => {
  test('the daemon reads a GZIPPED catalog correctly', async () => {
    // Bun's fetch advertises gzip by default and inflates transparently. If it
    // did not, every assertion below would be diffing against an empty catalog.
    const res = await fetch(`http://127.0.0.1:${gateway.port}/models`, {
      headers: { authorization: 'Bearer sandbox-key' },
    })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const body = (await res.json()) as { models: Record<string, unknown> }
    expect(Object.keys(body.models).sort()).toEqual(Object.keys(FULL_NOW).sort())
  })

  test('1. stale baked file missing a CONNECTED provider model → exactly one restart', async () => {
    await bootAgainstGateway('anthropic')
    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await reconcileSelectableModelsAtBoot(() => {})

    expect(restarts.n).toBe(1)
    // Both fetches really went out, over the network, on the right URLs.
    expect(requests).toContain('/models?scope=managed')
    expect(requests).toContain('/models')
    const written = (JSON.parse(await readFile(target, 'utf8')) as {
      models: Record<string, unknown>
    }).models
    expect(written['anthropic/claude-opus-4-9']).toBeDefined()
    expect(written['grok-4.6']).toBeDefined()
    expect(written['openai/gpt-5.5']).toBeDefined()
    // The unconnected provider's new model is in the live catalog and stays out.
    expect(written['openai/gpt-6']).toBeUndefined()
  }, 30_000)

  test('2. the same file with that provider NOT connected → no restart', async () => {
    await bootAgainstGateway('')
    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await reconcileSelectableModelsAtBoot(() => {})

    // The managed lineup is registered from the bundled floor at boot, and the
    // live BYOK additions are not selectable. Nothing to do.
    expect(restarts.n).toBe(0)
    expect(await readFile(target, 'utf8').catch(() => null)).toBeNull()
  }, 30_000)

  test('3. ModelNotFound after the fact → catalog written + one restart', async () => {
    await bootAgainstGateway('anthropic')
    const restarts = { n: 0 }
    const target = await tempFile('session.json')
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )
    // The gateway starts serving a model nothing on this box has ever seen —
    // the shape of "a provider was connected between the reconcile and the send".
    state.full = { ...FULL_NOW, 'anthropic/claude-opus-5-0': { name: 'Claude Opus 5.0' } }

    const healed = await selfHealMissingModel({
      name: 'UnknownError',
      message: 'ModelNotFound: kortix/anthropic/claude-opus-5-0',
    })

    expect(healed).toBe(true)
    expect(restarts.n).toBe(1)
    const written = (JSON.parse(await readFile(target, 'utf8')) as {
      models: Record<string, unknown>
    }).models
    expect(written['anthropic/claude-opus-5-0']).toBeDefined()
  }, 30_000)

  test('4. an explicitly EMPTY managed listing injects no bundled floor', async () => {
    // The self-host shape: KORTIX_MANAGED_PROVIDER_ENABLED=false ⇒ 200 `{}`.
    state.managed = {}
    state.full = { ...STALE_BAKED.models }
    process.env.KORTIX_LLM_CONNECTED_PROVIDERS = 'anthropic'
    const catalogFile = await tempFile('baked.json', STALE_BAKED)
    startCatalogPrefetches(GATEWAY_ENV)
    // Let the ~3KB managed listing land before the config build, which is what
    // happens on any box whose gateway is not pathologically slow.
    await new Promise((r) => setTimeout(r, 150))
    const raw = await buildOpencodeConfigContent({
      ...GATEWAY_ENV,
      KORTIX_LLM_CATALOG_FILE: catalogFile,
    } as NodeJS.ProcessEnv)
    const models = (
      JSON.parse(raw!) as { provider: { kortix: { models: Record<string, unknown> } } }
    ).provider.kortix.models

    expect(models['grok-4.6']).toBeUndefined()
    expect(models['deepseek-v4-flash']).toBeUndefined()
    expect(models['anthropic/claude-sonnet-4-6']).toBeDefined()

    // And the reconcile agrees: nothing selectable is missing, so no restart.
    const restarts = { n: 0 }
    process.env.KORTIX_LLM_CATALOG_FILE = catalogFile
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: await tempFile('session.json'), turnProbe: async () => false },
    )
    await reconcileSelectableModelsAtBoot(() => {})
    expect(restarts.n).toBe(0)
  }, 30_000)
})
