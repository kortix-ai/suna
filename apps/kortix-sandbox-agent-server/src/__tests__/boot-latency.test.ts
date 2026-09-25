import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { loadConfig } from '../config'
import { isShallowRepo, scheduleHistoryBackfill } from '../git'

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
  test('loads the API-provided fast-boot Git delta bundle and parent commit', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      KORTIX_GIT_DELTA_BUNDLE_BASE64: 'R0lUIEJVTkRMRQ==',
      KORTIX_GIT_DELTA_PARENT_SHA: 'a'.repeat(40),
      KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: 'dHJlZSBkZWFkYmVlZgo=',
    } as NodeJS.ProcessEnv)
    expect(cfg.gitDeltaBundleBase64).toBe('R0lUIEJVTkRMRQ==')
    expect(cfg.gitDeltaParentSha).toBe('a'.repeat(40))
    expect(cfg.gitDeltaParentCommitBase64).toBe('dHJlZSBkZWFkYmVlZgo=')
  })

  test('defaults to a shallow depth-1 clone', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).cloneDepth).toBe(1)
  })

  test('defaults compiled boot to off', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).compiledBootMode).toBe('off')
  })

  test.each(['shadow', 'prefer', 'required'] as const)('accepts compiled boot mode %s', (mode) => {
    expect(
      loadConfig({ ...BASE_ENV, KORTIX_COMPILED_BOOT_MODE: mode } as NodeJS.ProcessEnv)
        .compiledBootMode,
    ).toBe(mode)
  })

  test('rejects an unknown compiled boot mode', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KORTIX_COMPILED_BOOT_MODE: 'enabled' } as NodeJS.ProcessEnv),
    ).toThrow()
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
