import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { loadConfig } from '../config'
import { isShallowRepo, scheduleHistoryBackfill } from '../git'
import {
  BUNDLED_MANAGED_MODELS,
  MINIMAL_FALLBACK_MODELS,
  buildOpencodeConfigContent,
  catalogIsDegraded,
  hasKortixLlmGateway,
  scheduleCatalogWarmToPathForTests,
} from '../opencode'

const BASE_ENV = { KORTIX_WORKSPACE: '/workspace', KORTIX_REPO_URL: 'https://example.test/r.git' }

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

async function makeOriginRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-origin-'))
  git(dir, 'init', '--initial-branch=main', '--quiet')
  git(dir, 'config', 'user.email', 't@example.test')
  git(dir, 'config', 'user.name', 'Test')
  for (let i = 0; i < 3; i++) {
    await writeFile(join(dir, `f${i}.txt`), `v${i}`)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', `c${i}`, '--quiet')
  }
  return dir
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('clone depth configuration', () => {
  test('loads the API-provided fast-boot Git delta bundle', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      KORTIX_GIT_DELTA_BUNDLE_BASE64: 'R0lUIEJVTkRMRQ==',
    } as NodeJS.ProcessEnv)
    expect(cfg.gitDeltaBundleBase64).toBe('R0lUIEJVTkRMRQ==')
  })

  test('defaults to a shallow depth-1 clone', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).cloneDepth).toBe(1)
  })

  test('no partial-clone filter is applied by default', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).cloneFilter).toBe('')
  })

  test('depth 0 opts back into a full-history clone', () => {
    expect(loadConfig({ ...BASE_ENV, KORTIX_CLONE_DEPTH: '0' } as NodeJS.ProcessEnv).cloneDepth).toBe(0)
  })

  test('an explicit depth is honoured', () => {
    expect(loadConfig({ ...BASE_ENV, KORTIX_CLONE_DEPTH: '25' } as NodeJS.ProcessEnv).cloneDepth).toBe(25)
  })

  test('a negative depth is rejected rather than silently passed to git', () => {
    expect(() => loadConfig({ ...BASE_ENV, KORTIX_CLONE_DEPTH: '-1' } as NodeJS.ProcessEnv)).toThrow()
  })
})

describe('isShallowRepo', () => {
  test('reports true for a depth-limited clone and false once unshallowed', async () => {
    const origin = await makeOriginRepo()
    const clone = await mkdtemp(join(tmpdir(), 'kortix-clone-'))
    tempDirs.push(origin, clone)
    const target = join(clone, 'repo')

    git(clone, 'clone', '--depth', '1', '--branch', 'main', `file://${origin}`, target)
    expect(await isShallowRepo(target)).toBe(true)

    git(target, 'fetch', '--unshallow', 'origin')
    expect(await isShallowRepo(target)).toBe(false)
  })

  test('reports false for a full clone', async () => {
    const origin = await makeOriginRepo()
    const clone = await mkdtemp(join(tmpdir(), 'kortix-full-'))
    tempDirs.push(origin, clone)
    const target = join(clone, 'repo')

    git(clone, 'clone', '--branch', 'main', `file://${origin}`, target)
    expect(await isShallowRepo(target)).toBe(false)
  })

  test('a depth-1 clone carries exactly one commit while a full clone carries every commit', async () => {
    const origin = await makeOriginRepo()
    const clone = await mkdtemp(join(tmpdir(), 'kortix-depths-'))
    tempDirs.push(origin, clone)
    const shallow = join(clone, 'shallow')
    const full = join(clone, 'full')

    git(clone, 'clone', '--depth', '1', '--branch', 'main', `file://${origin}`, shallow)
    git(clone, 'clone', '--branch', 'main', `file://${origin}`, full)

    expect(git(shallow, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(full, 'rev-list', '--count', 'HEAD').trim()).toBe('3')
    expect(git(shallow, 'rev-parse', 'HEAD')).toBe(git(full, 'rev-parse', 'HEAD'))
  })
})

describe('scheduleHistoryBackfill', () => {
  test('restores full history for a shallow clone without blocking the caller', async () => {
    const origin = await makeOriginRepo()
    const clone = await mkdtemp(join(tmpdir(), 'kortix-backfill-'))
    tempDirs.push(origin, clone)
    const target = join(clone, 'repo')
    git(clone, 'clone', '--depth', '1', '--branch', 'main', `file://${origin}`, target)

    const cfg = loadConfig({ ...BASE_ENV, KORTIX_REPO_URL: `file://${origin}` } as NodeJS.ProcessEnv)
    scheduleHistoryBackfill(cfg, target)

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && (await isShallowRepo(target))) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(await isShallowRepo(target)).toBe(false)
    expect(git(target, 'rev-list', '--count', 'HEAD').trim()).toBe('3')
  })

  test('is a no-op on an already-complete repo', async () => {
    const origin = await makeOriginRepo()
    const clone = await mkdtemp(join(tmpdir(), 'kortix-noop-'))
    tempDirs.push(origin, clone)
    const target = join(clone, 'repo')
    git(clone, 'clone', '--branch', 'main', `file://${origin}`, target)

    const cfg = loadConfig({ ...BASE_ENV, KORTIX_REPO_URL: `file://${origin}` } as NodeJS.ProcessEnv)
    scheduleHistoryBackfill(cfg, target)
    await new Promise((r) => setTimeout(r, 300))

    expect(await isShallowRepo(target)).toBe(false)
    expect(git(target, 'rev-list', '--count', 'HEAD').trim()).toBe('3')
  })
})

describe('building the opencode boot config never touches the network', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1',
    KORTIX_LLM_API_KEY: 'k-test',
    KORTIX_API_URL: 'https://api.kortix.test/v1',
  }

  test('the env under test really does engage the gateway path', () => {
    expect(hasKortixLlmGateway(GATEWAY_ENV as NodeJS.ProcessEnv)).toBe(true)
  })

  test('makes zero fetch calls even with no catalog file on disk', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const raw = await buildOpencodeConfigContent(GATEWAY_ENV as NodeJS.ProcessEnv)

    expect(calls).toEqual([])
    expect(raw).toBeDefined()
  })

  test('an unreachable gateway costs no boot latency at all', async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 30_000))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const started = Date.now()
    const raw = await buildOpencodeConfigContent(GATEWAY_ENV as NodeJS.ProcessEnv)

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(raw).toBeDefined()
  })

  test('falls back to the minimal model set rather than blocking, and says so', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch

    const raw = await buildOpencodeConfigContent(GATEWAY_ENV as NodeJS.ProcessEnv)
    const parsed = JSON.parse(raw!) as { provider: { kortix: { models: Record<string, unknown> } } }

    expect(Object.keys(parsed.provider.kortix.models)).toEqual(Object.keys(MINIMAL_FALLBACK_MODELS))
  })

  test('a catalog file on disk is used verbatim (plus the managed floor), still with no fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-catalog-'))
    tempDirs.push(dir)
    const file = join(dir, 'catalog.json')
    await writeFile(file, JSON.stringify({ models: { 'test/only-model': { name: 'Only Model' } } }))

    const calls: string[] = []
    globalThis.fetch = (async (input: string) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const raw = await buildOpencodeConfigContent({
      ...GATEWAY_ENV,
      KORTIX_LLM_CATALOG_FILE: file,
    } as NodeJS.ProcessEnv)
    const parsed = JSON.parse(raw!) as { provider: { kortix: { models: Record<string, unknown> } } }

    // The file's own models survive untouched...
    expect(parsed.provider.kortix.models['test/only-model']).toBeDefined()
    // ...and the BUNDLED managed set fills the ids it lacks, so a baked catalog
    // that predates a managed-lineup change can never hide a managed model from
    // OpenCode (prod incident 2026-08-19). Still zero network on the boot path.
    for (const id of Object.keys(BUNDLED_MANAGED_MODELS)) {
      expect(parsed.provider.kortix.models[id]).toBeDefined()
    }
    expect(calls).toEqual([])
  })

  test('catalogIsDegraded reports true with no file and false with one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-degraded-'))
    tempDirs.push(dir)
    const file = join(dir, 'catalog.json')

    expect(catalogIsDegraded(file)).toBe(true)
    await writeFile(file, JSON.stringify({ models: { 'a/b': { name: 'B' } } }))
    expect(catalogIsDegraded(file)).toBe(false)
  })
})

describe('catalog written to disk is rebuilt to a known shape, never passed through', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const GATEWAY = { KORTIX_LLM_BASE_URL: 'https://gw.kortix.test/v1', KORTIX_LLM_API_KEY: 'k' }

  async function warmThenRead(catalog: unknown): Promise<Record<string, any> | null> {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-warm-'))
    tempDirs.push(dir)
    const target = join(dir, 'llm-catalog.json')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: catalog }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    scheduleCatalogWarmToPathForTests(GATEWAY.KORTIX_LLM_BASE_URL, GATEWAY.KORTIX_LLM_API_KEY, target)
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

  test('drops unrecognised fields instead of writing them through', async () => {
    const written = await warmThenRead({
      'a/b': { name: 'B', reasoning: true, __proto__hack: 'x', arbitrary: { deep: 'junk' } },
    })
    expect(written).not.toBeNull()
    expect(written!['a/b'].name).toBe('B')
    expect(written!['a/b'].reasoning).toBe(true)
    expect(written!['a/b'].arbitrary).toBeUndefined()
  })

  test('rejects non-object model entries rather than persisting them', async () => {
    const written = await warmThenRead({ 'good/one': { name: 'G' }, 'bad/one': 'not-an-object' })
    expect(Object.keys(written!)).toEqual(['good/one'])
  })

  test('coerces a missing name to the model id rather than writing undefined', async () => {
    const written = await warmThenRead({ 'x/y': { reasoning: true } })
    expect(written!['x/y'].name).toBe('x/y')
  })

  test('keeps structured limit/cost objects but drops non-object ones', async () => {
    const written = await warmThenRead({
      'm/1': { name: 'M', limit: { context: 1000 }, cost: 'free' },
    })
    expect(written!['m/1'].limit).toEqual({ context: 1000 })
    expect(written!['m/1'].cost).toBeUndefined()
  })
})
