import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { runtimeManifestSigningPayload } from '@kortix/api-contract/runtime-manifest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSafeOverlayPath,
  overlayHash,
  reconcileRuntimeAssets,
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

describe('overlay hashing and path safety', () => {
  test('hash matches the API implementation for the same input', () => {
    // Same framing as apps/api/src/runtime-assets/managed-skills.ts.
    const h = createHash('sha256')
    for (const f of SKILL_FILES) {
      h.update(`file\0${f.path}\0${Buffer.byteLength(f.content)}\0`)
      h.update(f.content)
      h.update('\0')
    }
    expect(SKILLS_HASH).toBe(h.digest('hex'))
  })

  test('rejects traversal, absolute, and non-kortix overlay paths', () => {
    expect(isSafeOverlayPath('kortix-system/SKILL.md')).toBe(true)
    expect(isSafeOverlayPath('kortix-system/references/a.md')).toBe(true)
    expect(isSafeOverlayPath('../etc/passwd')).toBe(false)
    expect(isSafeOverlayPath('/etc/passwd')).toBe(false)
    expect(isSafeOverlayPath('kortix-system/../../evil')).toBe(false)
    expect(isSafeOverlayPath('other-skill/SKILL.md')).toBe(false)
    expect(isSafeOverlayPath('')).toBe(false)
  })
})

describe('reconcileRuntimeAssets', () => {
  test('an enrollment-pinned key rejects unsigned and tampered manifests before download', async () => {
    const ws = await workspace()
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const unsigned = { cli_version: null, cli_sha256: null, cli_size: null, managed_skills_hash: '', build: 7, components: {}, policy: { agent_self_update: true } }
    const signature = sign(null, Buffer.from(runtimeManifestSigningPayload(unsigned)), privateKey).toString('base64')
    const tampered = { ...unsigned, build: 8, signature: { algorithm: 'ed25519', key_id: 'test', value: signature } }
    const fetchImpl = (async () => Response.json(tampered)) as unknown as typeof fetch
    const result = await reconcileRuntimeAssets({ apiUrl: API_URL, token: TOKEN, cliPath: ws.cliPath, managedSkillsDir: ws.skillsDir, statePath: ws.statePath, manifestSigningPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), fetchImpl })
    expect(result).toEqual({ cli: 'failed', skills: 'failed', reason: 'runtime manifest signature is missing or invalid' })
  })

  test('an enrollment-pinned key accepts the exact signed manifest', async () => {
    const ws = await workspace()
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const unsigned = { cli_version: null, cli_sha256: null, cli_size: null, managed_skills_hash: '', build: 7, components: {}, policy: { agent_self_update: true } }
    const manifest = { ...unsigned, signature: { algorithm: 'ed25519', key_id: 'test', value: sign(null, Buffer.from(runtimeManifestSigningPayload(unsigned)), privateKey).toString('base64') } }
    const fetchImpl = (async () => Response.json(manifest)) as unknown as typeof fetch
    const result = await reconcileRuntimeAssets({ apiUrl: API_URL, token: TOKEN, cliPath: ws.cliPath, managedSkillsDir: ws.skillsDir, statePath: ws.statePath, manifestSigningPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), fetchImpl })
    expect(result.build).toBe(7)
    expect(result.cli).toBe('skipped')
  })

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

  test('matching digests → no download, both halves current', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    const first = await run(ws, stubFetch())
    expect(first).toEqual({ cli: 'current', skills: 'updated' })

    const second = stubFetch()
    const result = await run(ws, second)
    expect(result).toEqual({ cli: 'current', skills: 'current' })
    expect(second.calls).toEqual([`${API_URL}/v1/runtime-assets/manifest`])
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

  test('unsafe overlay paths are dropped, safe siblings still land', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'NEW-CLI-BYTES')
    const files = [
      { path: 'kortix-system/SKILL.md', content: 'ok\n' },
      { path: '../escaped.md', content: 'pwned\n' },
    ]
    const stub = stubFetch({ skillFiles: files, skillsHash: overlayHash(files) })

    const result = await run(ws, stub)

    expect(result.skills).toBe('updated')
    expect(await readFile(join(ws.skillsDir, 'kortix-system/SKILL.md'), 'utf8')).toBe('ok\n')
    expect(await stat(join(ws.root, 'opt', 'escaped.md')).catch(() => null)).toBeNull()
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
      injectSkills: async (configDir: string, bakedDir: string) => {
        injected.push(`${configDir}|${bakedDir}`)
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
      injectSkills: async () => {
        injected.push('called')
      },
    })
    expect(result.skills).toBe('current')
    expect(injected).toEqual([])
  })

  test('the manifest always beats a stale digest cache', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    const stats = await stat(ws.cliPath)
    // A cache that claims the on-disk binary is already the new one.
    await Bun.write(
      ws.statePath,
      JSON.stringify({
        cli_sha256: sha('SOMETHING-ELSE'),
        cli_size: stats.size,
        cli_mtime_ms: Math.trunc(stats.mtimeMs),
      }),
    )

    const result = await run(ws, stubFetch())

    expect(result.cli).toBe('updated')
    expect(await readFile(ws.cliPath, 'utf8')).toBe('NEW-CLI-BYTES')
  })

  test('is idempotent — a second pass changes nothing', async () => {
    const ws = await workspace()
    await Bun.write(ws.cliPath, 'OLD-CLI-BYTES')
    await run(ws, stubFetch())
    const afterFirst = await stat(ws.cliPath)
    const result = await run(ws, stubFetch())
    expect(result).toEqual({ cli: 'current', skills: 'current' })
    expect((await stat(ws.cliPath)).mtimeMs).toBe(afterFirst.mtimeMs)
  })
})
