import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  overlayHash,
  reconcileRuntimeAssets,
  resetRuntimeConvergenceForTests,
} from '../runtime-assets'

const API_URL = 'https://api.test.invalid'
const TOKEN = 'kortix_pat_test'

const dirs: string[] = []

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-daemon-'))
  dirs.push(dir)
  return {
    root: dir,
    cliPath: join(dir, 'bin', 'kortix'),
    skillsDir: join(dir, 'opt', 'managed-skills'),
    statePath: join(dir, 'opt', 'runtime-assets-state.json'),
    configDir: join(dir, 'config'),
  }
}

afterEach(async () => {
  resetRuntimeConvergenceForTests()
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true })
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const SKILL_FILES = [
  { path: 'kortix-system/SKILL.md', content: '---\ndescription: how kortix works\n---\nbody v2\n' },
  { path: 'kortix-cli/SKILL.md', content: 'cli skill v2\n' },
]
const SKILLS_HASH = overlayHash(SKILL_FILES)

interface StubOptions {
  cliBody?: string
  cliSha?: string
  skillsHash?: string
  skillFiles?: { path: string; content: string }[]
  manifestStatus?: number
  cliStatus?: number
  skillsStatus?: number
}

function stubFetch(opts: StubOptions = {}) {
  const calls: string[] = []
  const cliBody = opts.cliBody ?? 'NEW-CLI-BYTES'
  const manifest = {
    cli_version: '0.12.9+abc12345',
    cli_sha256: opts.cliSha === undefined ? sha(cliBody) : opts.cliSha,
    cli_size: cliBody.length,
    managed_skills_hash: opts.skillsHash ?? SKILLS_HASH,
  }
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/runtime-assets/manifest')) {
      if (opts.manifestStatus && opts.manifestStatus !== 200) {
        return new Response('nope', { status: opts.manifestStatus })
      }
      return Response.json(manifest)
    }
    if (url.endsWith('/runtime-assets/cli')) {
      if (opts.cliStatus && opts.cliStatus !== 200) {
        return new Response('nope', { status: opts.cliStatus })
      }
      return new Response(cliBody)
    }
    if (url.endsWith('/runtime-assets/managed-skills')) {
      if (opts.skillsStatus && opts.skillsStatus !== 200) {
        return new Response('nope', { status: opts.skillsStatus })
      }
      return Response.json({
        hash: opts.skillsHash ?? SKILLS_HASH,
        files: opts.skillFiles ?? SKILL_FILES,
      })
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function run(ws: Awaited<ReturnType<typeof workspace>>, stub: ReturnType<typeof stubFetch>, extra: Record<string, unknown> = {}) {
  return reconcileRuntimeAssets({
    apiUrl: API_URL,
    token: TOKEN,
    cliPath: ws.cliPath,
    managedSkillsDir: ws.skillsDir,
    statePath: ws.statePath,
    fetchImpl: stub.impl,
    ...extra,
  })
}

describe('overlay hashing', () => {
  test('hash is the one apps/api computes for the same input (golden vector)', () => {
    // The same hex is pinned in apps/api/src/runtime-assets/__tests__/manifest.test.ts
    // for managedSkillOverlayHash. Either side drifting fails its own suite.
    expect(SKILLS_HASH).toBe('453944bd7d750bb9b878fee50df662da07552c962238bc37a95f96853a75bcf9')
  })
})

describe('reconcileRuntimeAssets', () => {
  test('no api url or token → skipped, no fetch at all', async () => {
    const ws = await workspace()
    const stub = stubFetch()
    const result = await reconcileRuntimeAssets({
      apiUrl: '',
      token: '',
      cliPath: ws.cliPath,
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      fetchImpl: stub.impl,
    })
    expect(result).toEqual({ cli: 'skipped', skills: 'skipped', reason: 'api url or token unset' })
    expect(stub.calls).toEqual([])
  })

  test('digest mismatch → binary replaced, mode 0755, overlay written', async () => {
    const ws = await workspace()
    await writeFile(ws.cliPath.replace(/\/kortix$/, '/.keep'), '').catch(() => {})
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const stub = stubFetch()

    const result = await run(ws, stub)

    expect(result).toEqual({ cli: 'updated', skills: 'updated' })
    expect(await readFile(ws.cliPath, 'utf8')).toBe('NEW-CLI-BYTES')
    expect((await stat(ws.cliPath)).mode & 0o777).toBe(0o755)
    expect(await readFile(join(ws.skillsDir, 'kortix-system/SKILL.md'), 'utf8')).toContain('body v2')
    expect(await readFile(join(ws.skillsDir, 'kortix-cli/SKILL.md'), 'utf8')).toBe('cli skill v2\n')
    // No staging or retired directories left behind.
    const opt = await readdir(join(ws.root, 'opt'))
    expect(opt.filter((e) => e.includes('staging') || e.includes('retired'))).toEqual([])
  })

  // Idempotent from either starting binary: once converged, a pass reads the
  // manifest and nothing else, and leaves the binary's mtime alone.
  test.each([
    ['NEW-CLI-BYTES', 'current'],
    ['OLD-CLI-BYTES', 'updated'],
  ] as const)('starting from %s, the first pass reports cli %s and the second changes nothing', async (start, firstCli) => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, start)
    const first = await run(ws, stubFetch())
    expect(first).toEqual({ cli: firstCli, skills: 'updated' })
    const afterFirst = await stat(ws.cliPath)

    const second = stubFetch()
    const result = await run(ws, second)
    expect(result).toEqual({ cli: 'current', skills: 'current' })
    expect(second.calls).toEqual([`${API_URL}/v1/runtime-assets/manifest`])
    expect((await stat(ws.cliPath)).mtimeMs).toBe(afterFirst.mtimeMs)
  })

  test('manifest reports no CLI → CLI half skipped, binary untouched', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const stub = stubFetch({ cliSha: undefined })
    const result = await reconcileRuntimeAssets({
      apiUrl: API_URL,
      token: TOKEN,
      cliPath: ws.cliPath,
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/manifest')) {
          return Response.json({
            cli_version: null,
            cli_sha256: null,
            cli_size: null,
            managed_skills_hash: SKILLS_HASH,
          })
        }
        return stub.impl(input as never)
      }) as unknown as typeof fetch,
    })
    expect(result.cli).toBe('skipped')
    expect(result.skills).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('OLD-CLI-BYTES')
  })

  test('manifest unreachable → both skipped, nothing written', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const result = await run(ws, stubFetch({ manifestStatus: 503 }))
    expect(result.cli).toBe('skipped')
    expect(result.skills).toBe('skipped')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('OLD-CLI-BYTES')
    expect(await stat(ws.skillsDir).catch(() => null)).toBeNull()
  })

  test('manifest fetch throws → skipped, never propagates', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const result = await reconcileRuntimeAssets({
      apiUrl: API_URL,
      token: TOKEN,
      cliPath: ws.cliPath,
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    })
    expect(result.cli).toBe('skipped')
    expect(result.reason).toContain('ECONNREFUSED')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('OLD-CLI-BYTES')
  })

  test('download digest mismatch → abort, installed binary untouched, no temp left', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    // The manifest promises one digest; the body delivers different bytes.
    const stub = stubFetch({ cliBody: 'TRUNCATED', cliSha: sha('THE-FULL-BINARY') })

    const result = await run(ws, stub)

    expect(result.cli).toBe('failed')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('OLD-CLI-BYTES')
    const binDir = await readdir(join(ws.root, 'bin'))
    expect(binDir).toEqual(['kortix'])
  })

  test('CLI download 500 → failed, binary untouched, skills still reconcile', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const result = await run(ws, stubFetch({ cliStatus: 500 }))
    expect(result.cli).toBe('failed')
    expect(result.skills).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('OLD-CLI-BYTES')
  })

  test('overlay payload digest mismatch → keeps the existing overlay', async () => {
    const ws = await workspace()
    await Bun.write(join(ws.skillsDir, 'kortix-system/SKILL.md'), 'body v1\n')
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    // Manifest advertises the real hash; the payload delivers other files.
    const stub = stubFetch({ skillFiles: [{ path: 'kortix-system/SKILL.md', content: 'tampered' }] })

    const result = await run(ws, stub)

    expect(result.skills).toBe('failed')
    expect(await readFile(join(ws.skillsDir, 'kortix-system/SKILL.md'), 'utf8')).toBe('body v1\n')
  })

  test.each([
    '../escaped.md',
    '/etc/escaped.md',
    'kortix-system/../../escaped.md',
    'other-skill/SKILL.md',
    '',
  ])('an unsafe overlay path %p is dropped, a safe sibling still lands', async (unsafe) => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    const files = [
      { path: 'kortix-system/references/a.md', content: 'ok\n' },
      { path: unsafe, content: 'pwned\n' },
    ]
    const stub = stubFetch({ skillFiles: files, skillsHash: overlayHash(files) })

    const result = await run(ws, stub)

    expect(result.skills).toBe('updated')
    expect(await readFile(join(ws.skillsDir, 'kortix-system/references/a.md'), 'utf8')).toBe('ok\n')
    expect(await stat(join(ws.root, 'opt', 'escaped.md')).catch(() => null)).toBeNull()
    expect(await stat('/etc/escaped.md').catch(() => null)).toBeNull()
    expect(await stat(join(ws.skillsDir, 'other-skill')).catch(() => null)).toBeNull()
  })

  test('missing overlay dir is created even when the hash already matches state', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    // This is the per-project sandbox case: state says converged, but the image
    // never baked /opt/kortix/managed-skills at all.
    await Bun.write(ws.statePath, JSON.stringify({ managed_skills_hash: SKILLS_HASH }))

    const result = await run(ws, stubFetch())

    expect(result.skills).toBe('updated')
    expect(await readFile(join(ws.skillsDir, 'kortix-cli/SKILL.md'), 'utf8')).toBe('cli skill v2\n')
  })

  test('an overlay update re-injects into the live config dir', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    const injected: string[] = []
    const result = await run(ws, stubFetch(), {
      configDir: ws.configDir,
      assets: {
        componentNames: [],
        resolveConfigDir: async () => ws.configDir,
        injectSkills: async (configDir: string, bakedDir: string) => {
          injected.push(`${configDir}|${bakedDir}`)
        },
        reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
      },
    })
    expect(result.skills).toBe('updated')
    expect(injected).toEqual([`${ws.configDir}|${ws.skillsDir}`])
  })

  test('no re-injection when the overlay was already current', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    await run(ws, stubFetch())
    const injected: string[] = []
    const result = await run(ws, stubFetch(), {
      configDir: ws.configDir,
      assets: {
        componentNames: [],
        resolveConfigDir: async () => ws.configDir,
        injectSkills: async () => {
          injected.push('called')
        },
        reconcile: async () => ({ components: {}, reasons: {}, state: {} }),
      },
    })
    expect(result.skills).toBe('current')
    expect(injected).toEqual([])
  })

  test('the digest cache is keyed on size and mtime: a stale mtime forces a real hash and a download', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const stats = await stat(ws.cliPath)
    // The cache claims the on-disk binary IS the manifest build, but for an
    // mtime the file no longer has.
    await Bun.write(
      ws.statePath,
      JSON.stringify({
        cli_sha256: sha('NEW-CLI-BYTES'),
        cli_size: stats.size,
        cli_mtime_ms: Math.trunc(stats.mtimeMs) - 5_000,
      }),
    )

    const result = await run(ws, stubFetch())

    expect(result.cli).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('NEW-CLI-BYTES')
  })
})
