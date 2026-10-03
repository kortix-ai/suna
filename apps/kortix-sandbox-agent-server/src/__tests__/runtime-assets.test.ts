import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bakeRuntimeAssetsState,
  overlayHash,
  reconcileRuntimeAssets,
  resetRuntimeConvergenceForTests,
  runningRuntimeAssets,
  __resetVerifiedDigestsForTests,
  registerHarnessAssets,
  resetHarnessAssetsForTests,
} from '@/services/runtime-assets/runtime-assets'
import {
  SESSION_TOKEN_DEAD_PROBE_MS,
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
  sessionTokenPresumedDead,
} from '@/lib/kortix-api/session-token-health'
import { resolveHarness } from '@/harness/harness'

// Production registers this lookup in main.ts before anything runs.
beforeAll(() => registerHarnessAssets((cfg) => resolveHarness(cfg).assets))
afterAll(() => resetHarnessAssetsForTests())

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
  resetSessionTokenHealthForTests()
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true })
})

beforeEach(() => {
  resetSessionTokenHealthForTests()
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
    // The fixtures are text files, not executables. A downloaded CLI is now
    // EXECUTED before it replaces a working one, so every case that is not about
    // that check says "it ran". See `ExecProbe` in ../runtime-assets.ts.
    execProbe: async () => 0,
    // The chunk indexer hashes every block of every local source. The box's
    // real agent binary (the baked-path default, ~110 MB inside a platform
    // image; absent on CI) would join that index, so pin both agent paths to
    // fixture locations that do not exist — the CI condition.
    agentStateDir: join(ws.root, 'opt', 'agent-state'),
    agentBakedPath: join(ws.root, 'opt', 'agent-baked'),
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

  test('a successful manifest fetch clears the shared dead-token breaker', async () => {
    // KRTX-613: the breaker only ever saw failures, so it tripped and never
    // cleared — a pause gated on it would be permanent. The manifest fetch is
    // the control-plane call that runs every runtime-truth tick. KRTX-636 skips
    // it while the breaker is tripped, so it goes out once per probe window,
    // and its 2xx is the signal that the credential works again.
    const ws = await workspace()
    const stub = stubFetch()
    setSystemTime(new Date('2026-09-28T00:00:00Z'))
    try {
      for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
        noteControlPlaneResponse(401, 'Session token is not active')
      }
      expect(sessionTokenPresumedDead()).toBe(true)

      await run(ws, stub) // inside the probe window: skipped
      expect(stub.calls).toEqual([])

      setSystemTime(new Date(Date.now() + SESSION_TOKEN_DEAD_PROBE_MS))
      await run(ws, stub)
    } finally {
      setSystemTime()
    }

    expect(sessionTokenPresumedDead()).toBe(false)
    expect(stub.calls.some((url) => url.endsWith('/runtime-assets/manifest'))).toBe(true)
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
    // Stat through a handle, not the path: the code under test replaces this
    // file before the read below, which a path stat-then-read reads as a race.
    const handle = await open(ws.cliPath)
    const stats = await handle.stat()
    await handle.close()
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

// ── The image bake ─────────────────────────────────────────────────────────
//
// A sandbox image that carries the current CLI, daemon and skill overlay still
// cannot SAY so: `/opt/kortix/runtime-assets-state.json` is written only by a
// completed reconcile, so a freshly booted box answers `runtime.running` with
// nulls until its first pass finishes — measured at ~140 s on a cold preview
// box. Baking the bytes without the bookkeeping fixes half the defect. These
// tests pin both halves: the bake states exactly what is on disk, and the pass
// that follows it downloads nothing.
describe('bakeRuntimeAssetsState', () => {
  // The API serves the overlay PATH-SORTED (`managedSkillOverlayFiles`), and a
  // bake reads it back off disk the same way. `SKILL_FILES` above is declared
  // in hash-vector order, not sorted order, so the bake's hash is this one.
  const BAKED_SKILL_FILES = [...SKILL_FILES].sort((a, b) => a.path.localeCompare(b.path))
  const BAKED_SKILLS_HASH = overlayHash(BAKED_SKILL_FILES)

  async function bakedImage() {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    await Bun.write(join(ws.root, 'bin', 'kortix-agent'), 'AGENT-BYTES')
    for (const file of SKILL_FILES) await Bun.write(join(ws.skillsDir, file.path), file.content)
    return ws
  }

  test('states the digests of the files the image actually carries', async () => {
    const ws = await bakedImage()

    const state = await bakeRuntimeAssetsState({
      cliPath: ws.cliPath,
      agentPath: join(ws.root, 'bin', 'kortix-agent'),
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      harnessVersion: '1.18.23',
    })

    const onDisk = JSON.parse(await readFile(ws.statePath, 'utf8'))
    expect(onDisk).toEqual(state)
    expect(state.cli_sha256).toBe(sha('NEW-CLI-BYTES'))
    expect(state.cli_path).toBe(ws.cliPath)
    expect(state.agent_sha256).toBe(sha('AGENT-BYTES'))
    expect(state.agent_path).toBe(join(ws.root, 'bin', 'kortix-agent'))
    expect(state.managed_skills_hash).toBe(BAKED_SKILLS_HASH)
    expect(state.harness).toBe('opencode')
    expect(state.harness_version).toBe('1.18.23')
    // `build` is the epoch of a manifest this box READ. An image build reads
    // none, so claiming one would let the epoch guard refuse a legitimate API.
    expect(state.build).toBeUndefined()
  })

  test('the first reconcile on a baked box is a no-op: manifest only, nothing downloaded', async () => {
    const ws = await bakedImage()
    await bakeRuntimeAssetsState({
      cliPath: ws.cliPath,
      agentPath: join(ws.root, 'bin', 'kortix-agent'),
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      harnessVersion: '1.18.23',
    })

    const stub = stubFetch({
      cliBody: 'NEW-CLI-BYTES',
      skillsHash: BAKED_SKILLS_HASH,
      skillFiles: BAKED_SKILL_FILES,
    })
    const result = await run(ws, stub)

    expect(result).toMatchObject({ cli: 'current', skills: 'current' })
    expect(stub.calls).toEqual([`${API_URL}/v1/runtime-assets/manifest`])
  })

  test('a box states which bytes it runs before any reconcile has happened', async () => {
    const ws = await bakedImage()
    await bakeRuntimeAssetsState({
      cliPath: ws.cliPath,
      agentPath: join(ws.root, 'bin', 'kortix-agent'),
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      harnessVersion: '1.18.23',
    })

    const running = await runningRuntimeAssets(ws.statePath)

    expect(running.cli_sha256).toBe(sha('NEW-CLI-BYTES'))
    expect(running.agent_sha256).toBe(sha('AGENT-BYTES'))
    expect(running.managed_skills_hash).toBe(BAKED_SKILLS_HASH)
    expect(running.harness).toBe('opencode')
    expect(running.harness_version).toBe('1.18.23')
  })

  test('a binary replaced after the bake reports the bytes now on disk, not the baked digest', async () => {
    // The Platinum agent-swap fast path patches the agent binary into the
    // predecessor's rootfs and keeps its state file. Before this, a fresh box
    // reported the predecessor's agent digest until its first reconcile, and
    // session open relaunched a daemon that already ran the right bytes.
    const ws = await bakedImage()
    const agentPath = join(ws.root, 'bin', 'kortix-agent')
    await bakeRuntimeAssetsState({
      cliPath: ws.cliPath,
      agentPath,
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      harnessVersion: '1.18.23',
    })
    __resetVerifiedDigestsForTests()

    await Bun.write(agentPath, 'SWAPPED-IN-AGENT-BYTES')
    const running = await runningRuntimeAssets(ws.statePath)

    expect(running.agent_sha256).toBe(sha('SWAPPED-IN-AGENT-BYTES'))
    expect(running.agent_path).toBe(agentPath)
    // The CLI was not touched: the baked digest is still the truth.
    expect(running.cli_sha256).toBe(sha('NEW-CLI-BYTES'))
  })

  test('a baked digest whose file is gone cannot prove anything', async () => {
    const ws = await bakedImage()
    const agentPath = join(ws.root, 'bin', 'kortix-agent')
    await bakeRuntimeAssetsState({
      cliPath: ws.cliPath,
      agentPath,
      managedSkillsDir: ws.skillsDir,
      statePath: ws.statePath,
      harnessVersion: '1.18.23',
    })
    await rm(agentPath)

    const running = await runningRuntimeAssets(ws.statePath)

    expect(running.agent_sha256).toBeNull()
    expect(running.cli_sha256).toBe(sha('NEW-CLI-BYTES'))
  })

  test('a missing baked asset fails the image build instead of shipping a lie', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')

    await expect(
      bakeRuntimeAssetsState({
        cliPath: ws.cliPath,
        agentPath: join(ws.root, 'bin', 'kortix-agent'),
        managedSkillsDir: ws.skillsDir,
        statePath: ws.statePath,
      }),
    ).rejects.toThrow(/kortix-agent/)
  })
})

// ── Chunked transfer, through the real reconcile ───────────────────────────
//
// `stubFetch` above answers 500 on the chunk routes, so every case in this file
// takes the full download and proves the fallback is intact. This block is the
// other half: the same reconcile, against an API that DOES serve chunks.
describe('reconcileRuntimeAssets over chunks', () => {
  const CHUNK = 8
  const blocks = (letters: string) =>
    Buffer.concat([...letters].map((ch) => Buffer.alloc(CHUNK, ch.charCodeAt(0))))
  const shaBytes = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

  function chunkAwareStub(oldCli: Buffer, newCli: Buffer) {
    const chunks: string[] = []
    for (let o = 0; o < newCli.length; o += CHUNK) {
      chunks.push(shaBytes(newCli.subarray(o, o + CHUNK)))
    }
    const calls: string[] = []
    const impl = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/runtime-assets/manifest')) {
        return Response.json({
          cli_version: '0.12.9+abc12345',
          cli_sha256: shaBytes(newCli),
          cli_size: newCli.length,
          managed_skills_hash: SKILLS_HASH,
        })
      }
      if (url.endsWith('/runtime-assets/chunks/cli')) {
        return Response.json({
          sha256: shaBytes(newCli),
          size: newCli.length,
          chunk_size: CHUNK,
          chunks,
        })
      }
      if (url.includes('/runtime-assets/chunk/')) {
        const index = chunks.indexOf(url.slice(url.lastIndexOf('/') + 1))
        if (index === -1) return new Response('nope', { status: 404 })
        return new Response(newCli.subarray(index * CHUNK, (index + 1) * CHUNK))
      }
      if (url.endsWith('/runtime-assets/cli')) return new Response(newCli)
      if (url.endsWith('/runtime-assets/managed-skills')) {
        return Response.json({ hash: SKILLS_HASH, files: SKILL_FILES })
      }
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch
    return { impl, calls, chunks }
  }

  test('a version bump installs the new CLI without refetching the bytes that did not change', async () => {
    // The measured shape of a real version bump: 1 of 11 chunks differs.
    const oldCli = blocks('aaaaaaaaaaa')
    const newCli = blocks('aaaaaXaaaaa')
    const ws = await workspace()
    await Bun.write(ws.cliPath, oldCli)
    const stub = chunkAwareStub(oldCli, newCli)

    const result = await run(ws, stub as ReturnType<typeof stubFetch>)

    expect(result.cli).toBe('updated')
    expect(Buffer.compare(Buffer.from(await readFile(ws.cliPath)), newCli)).toBe(0)
    // The whole binary was never requested; exactly one chunk was.
    expect(stub.calls.filter((u) => u.endsWith('/runtime-assets/cli'))).toEqual([])
    expect(stub.calls.filter((u) => u.includes('/runtime-assets/chunk/'))).toEqual([
      `${API_URL}/v1/runtime-assets/chunk/${stub.chunks[5]}`,
    ])
  })

  test('an API that serves no chunk routes still converges — the full download is intact', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const stub = stubFetch()

    const result = await run(ws, stub)

    expect(result.cli).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('NEW-CLI-BYTES')
    expect(stub.calls).toContain(`${API_URL}/v1/runtime-assets/cli`)
  })
})
