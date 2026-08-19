import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { readRepoInfo } from '../git'

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function makeRepo(branch: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-rri-'))
  dirs.push(dir)
  git(dir, 'init', `--initial-branch=${branch}`, '--quiet')
  git(dir, 'config', 'user.email', 't@example.test')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'remote', 'add', 'origin', 'https://example.test/r.git')
  await writeFile(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'c0', '--quiet')
  return dir
}

describe('readRepoInfo', () => {
  test('returns null when the path is not a repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-rri-empty-'))
    dirs.push(dir)
    expect(await readRepoInfo(dir)).toBeNull()
  })

  test('reads branch, commit and remote from a real repo', async () => {
    const dir = await makeRepo('session-abc')
    const info = await readRepoInfo(dir)

    expect(info).not.toBeNull()
    expect(info!.branch).toBe('session-abc')
    expect(info!.remoteUrl).toBe('https://example.test/r.git')
    expect(info!.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(info!.path).toBe(dir)
  })

  test('concurrent reads of the same repo all agree', async () => {
    const dir = await makeRepo('main')
    const results = await Promise.all(Array.from({ length: 8 }, () => readRepoInfo(dir)))

    for (const info of results) {
      expect(info!.branch).toBe('main')
      expect(info!.commit).toBe(results[0]!.commit)
      expect(info!.remoteUrl).toBe('https://example.test/r.git')
    }
  })

  test('reflects the session branch after a checkout, which is what repo_ready gates on', async () => {
    const dir = await makeRepo('main')
    expect((await readRepoInfo(dir))!.branch).toBe('main')

    git(dir, 'checkout', '-B', 'session-xyz', '--quiet')
    expect((await readRepoInfo(dir))!.branch).toBe('session-xyz')
  })

  test('survives a repo with no origin remote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-rri-noremote-'))
    dirs.push(dir)
    git(dir, 'init', '--initial-branch=main', '--quiet')
    git(dir, 'config', 'user.email', 't@example.test')
    git(dir, 'config', 'user.name', 'Test')
    await writeFile(join(dir, 'a.txt'), 'a')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'c0', '--quiet')

    const info = await readRepoInfo(dir)
    expect(info!.branch).toBe('main')
    expect(info!.remoteUrl).toBeNull()
  })
})
