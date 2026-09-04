import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { loadConfig } from '../config'
import {
  COMPILED_CHECKOUT_CONTENT_TYPE,
  COMPILED_CHECKOUT_FORMAT,
  buildCompiledCheckoutUrl,
  materializeCompiledCheckoutToStage,
} from '../compiled-checkout'
import { materializeRepo } from '../git'

const roots: string[] = []
const realFetch = globalThis.fetch

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ivan Bagarić',
      GIT_AUTHOR_EMAIL: 'ino.bagaric.1@gmail.com',
      GIT_COMMITTER_NAME: 'Ivan Bagarić',
      GIT_COMMITTER_EMAIL: 'ino.bagaric.1@gmail.com',
    },
    encoding: 'utf8',
  }).trim()
}

function makeArtifact(): { archive: string; projectId: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'kortix-daemon-compiled-'))
  roots.push(root)
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-b', 'main')
  writeFileSync(join(checkout, 'README.md'), 'compiled workspace\n')
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-m', 'compiled source')
  const sha = git(checkout, 'rev-parse', 'HEAD')
  const projectId = '11111111-1111-4111-8111-111111111111'
  git(checkout, 'remote', 'add', 'origin', `https://api.kortix.test/v1/git/${projectId}.git`)
  writeFileSync(
    join(checkout, '.git', 'kortix-compiled-checkout.json'),
    `${JSON.stringify({
      format: COMPILED_CHECKOUT_FORMAT,
      project_id: projectId,
      ref: 'main',
      source_sha: sha,
      shallow: true,
    })}\n`,
  )
  const archive = join(root, 'checkout.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', checkout, '.'])
  return { archive, projectId, sha }
}

function responseFor(archive: string, sha256?: string): Response {
  const body = readFileSync(archive)
  return new Response(body, {
    headers: {
      'content-length': String(body.byteLength),
      'content-type': COMPILED_CHECKOUT_CONTENT_TYPE,
      'x-kortix-artifact-cache': 'hit',
      'x-kortix-artifact-format': COMPILED_CHECKOUT_FORMAT,
      'x-kortix-artifact-sha256': sha256 ?? createHash('sha256').update(body).digest('hex'),
    },
  })
}

afterEach(() => {
  globalThis.fetch = realFetch
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('buildCompiledCheckoutUrl', () => {
  test('derives an authenticated artifact endpoint from the Git proxy URL', () => {
    expect(
      buildCompiledCheckoutUrl(
        'https://api.kortix.test/v1/git/project.git',
        'feature/base',
        'a'.repeat(40),
      ),
    ).toBe(
      `https://api.kortix.test/v1/git/project.git/compiled-checkout?ref=feature%2Fbase&sha=${'a'.repeat(40)}`,
    )
  })
})

describe('materializeCompiledCheckoutToStage', () => {
  test('verifies and extracts the exact clean checkout', async () => {
    const { archive, projectId, sha } = makeArtifact()
    const stageRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-stage-'))
    roots.push(stageRoot)
    const stage = join(stageRoot, 'stage')
    const requests: Request[] = []
    const cfg = loadConfig({
      KORTIX_PROJECT_ID: projectId,
      KORTIX_REPO_URL: `https://api.kortix.test/v1/git/${projectId}.git`,
      KORTIX_BASE_SHA: sha,
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_COMPILED_BOOT_MODE: 'prefer',
    } as NodeJS.ProcessEnv)
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init))
      return responseFor(archive)
    }) as unknown as typeof fetch

    const metrics = await materializeCompiledCheckoutToStage(cfg, stage, 'main', { fetchImpl })

    expect(readFileSync(join(stage, 'README.md'), 'utf8')).toBe('compiled workspace\n')
    expect(git(stage, 'rev-parse', 'HEAD')).toBe(sha)
    expect(git(stage, 'status', '--porcelain')).toBe('')
    expect(metrics.bytes).toBeGreaterThan(0)
    expect(metrics.cache).toBe('hit')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer sandbox-token')
    expect(requests[0]!.headers.get('accept')).toBe(COMPILED_CHECKOUT_CONTENT_TYPE)
  })

  test('rejects a corrupted artifact before it can become the workspace', async () => {
    const { archive, projectId, sha } = makeArtifact()
    const stageRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-stage-'))
    roots.push(stageRoot)
    const stage = join(stageRoot, 'stage')
    const cfg = loadConfig({
      KORTIX_PROJECT_ID: projectId,
      KORTIX_REPO_URL: `https://api.kortix.test/v1/git/${projectId}.git`,
      KORTIX_BASE_SHA: sha,
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_COMPILED_BOOT_MODE: 'prefer',
    } as NodeJS.ProcessEnv)

    await expect(
      materializeCompiledCheckoutToStage(cfg, stage, 'main', {
        fetchImpl: (async () => responseFor(archive, 'f'.repeat(64))) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/SHA-256 mismatch/)
    expect(() => readFileSync(join(stage, 'README.md'), 'utf8')).toThrow()
  })

  test('rejects an artifact compiled for another project', async () => {
    const { archive, sha } = makeArtifact()
    const stageRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-stage-'))
    roots.push(stageRoot)
    const stage = join(stageRoot, 'stage')
    const cfg = loadConfig({
      KORTIX_PROJECT_ID: '22222222-2222-4222-8222-222222222222',
      KORTIX_REPO_URL: 'https://api.kortix.test/v1/git/other.git',
      KORTIX_BASE_SHA: sha,
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_COMPILED_BOOT_MODE: 'prefer',
    } as NodeJS.ProcessEnv)

    await expect(
      materializeCompiledCheckoutToStage(cfg, stage, 'main', {
        fetchImpl: (async () => responseFor(archive)) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/manifest does not match/)
  })
})

describe('materializeRepo compiled boot', () => {
  test('adopts the compiled checkout and creates the session branch without Git network work', async () => {
    const { archive, projectId, sha } = makeArtifact()
    const targetRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-target-'))
    roots.push(targetRoot)
    const target = join(targetRoot, 'workspace')
    const requests: string[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input))
      return responseFor(archive)
    }) as unknown as typeof fetch
    const cfg = loadConfig({
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_PROJECT_TARGET: target,
      KORTIX_PROJECT_ID: projectId,
      KORTIX_REPO_URL: `https://api.kortix.test/v1/git/${projectId}.git`,
      KORTIX_DEFAULT_BRANCH: 'main',
      KORTIX_BRANCH_NAME: 'session-1',
      KORTIX_SESSION_FRESH: '1',
      KORTIX_BASE_SHA: sha,
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_COMPILED_BOOT_MODE: 'prefer',
    } as NodeJS.ProcessEnv)

    await materializeRepo(cfg)

    expect(requests).toHaveLength(1)
    expect(git(target, 'branch', '--show-current')).toBe('session-1')
    expect(git(target, 'rev-parse', 'HEAD')).toBe(sha)
    expect(git(target, 'status', '--porcelain')).toBe('')
    expect(git(target, 'config', '--get', 'kortix.adopted-session')).toBe('session-1')
  })

  test('falls back to the existing clone path when the compiled checkout is unavailable', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-fallback-source-'))
    const targetRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-fallback-target-'))
    roots.push(sourceRoot, targetRoot)
    const source = join(sourceRoot, 'source')
    const target = join(targetRoot, 'workspace')
    mkdirSync(source)
    git(source, 'init', '-b', 'main')
    writeFileSync(join(source, 'README.md'), 'clone fallback\n')
    git(source, 'add', '-A')
    git(source, 'commit', '-m', 'fallback source')
    const sha = git(source, 'rev-parse', 'HEAD')
    const cfg = loadConfig({
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_PROJECT_TARGET: target,
      KORTIX_PROJECT_ID: '33333333-3333-4333-8333-333333333333',
      KORTIX_REPO_URL: `file://${source}`,
      KORTIX_DEFAULT_BRANCH: 'main',
      KORTIX_BRANCH_NAME: 'session-2',
      KORTIX_SESSION_FRESH: '1',
      KORTIX_BASE_SHA: sha,
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_COMPILED_BOOT_MODE: 'prefer',
    } as NodeJS.ProcessEnv)

    await materializeRepo(cfg)

    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('clone fallback\n')
    expect(git(target, 'branch', '--show-current')).toBe('session-2')
    expect(git(target, 'rev-parse', 'HEAD')).toBe(sha)
  })

  test('required mode rejects an unavailable artifact before the clone path', async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'kortix-daemon-required-target-'))
    roots.push(targetRoot)
    const target = join(targetRoot, 'workspace')
    const cfg = loadConfig({
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_PROJECT_TARGET: target,
      KORTIX_PROJECT_ID: '44444444-4444-4444-8444-444444444444',
      KORTIX_REPO_URL: 'file:///unavailable.git',
      KORTIX_DEFAULT_BRANCH: 'main',
      KORTIX_BRANCH_NAME: 'session-3',
      KORTIX_SESSION_FRESH: '1',
      KORTIX_BASE_SHA: 'a'.repeat(40),
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_COMPILED_BOOT_MODE: 'required',
    } as NodeJS.ProcessEnv)

    await expect(materializeRepo(cfg)).rejects.toThrow(/requires an HTTP\(S\) Git proxy URL/)
    expect(() => readFileSync(join(target, 'README.md'), 'utf8')).toThrow()
  })
})
