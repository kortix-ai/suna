/**
 * A session branch that was never pushed must not make `refresh` fail.
 *
 * The session branch is created LOCALLY at boot and only reaches origin when
 * the user proposes their changes. So for every session that has not proposed
 * yet — the majority, and by far the most likely to be told its config moved —
 * `git fetch origin refs/heads/<session-id>` has nothing to find:
 *
 *   fatal: couldn't find remote ref refs/heads/<session-id>
 *
 * `refreshRepo` treated that as fatal, so `POST /kortix/refresh` answered 500
 * and the Reload the stale-config notice offers was a dead end in exactly the
 * case it was offered.
 *
 * Found by running the real thing against dev rather than by reading the code:
 * a freshly provisioned session returned that error verbatim. Pre-existing —
 * the fetch predates the surrounding work — but it defeats the reload feature,
 * so it is fixed here.
 *
 * Real repositories, no mocks: the behaviour under test is git's, and the whole
 * bug was a wrong assumption about what git does when a ref is absent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../config'
import { refreshRepo } from '../git'

function git(args: string[], cwd?: string) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

let root: string
let origin: string
let work: string

const SESSION_ID = '5edfa699-4af7-42a4-b323-d317c8137cf8'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-refresh-'))
  origin = join(root, 'origin.git')
  work = join(root, 'workspace')

  git(['init', '--bare', '-b', 'main', origin])

  const seed = join(root, 'seed')
  mkdirSync(seed)
  git(['init', '-b', 'main'], seed)
  writeFileSync(join(seed, 'README.md'), 'base\n')
  git(['add', '.'], seed)
  git(['-c', 'user.email=t@k.dev', '-c', 'user.name=T', 'commit', '-m', 'base'], seed)
  git(['remote', 'add', 'origin', origin], seed)
  git(['push', '-u', 'origin', 'main'], seed)

  git(['clone', origin, work])
  // What the daemon does at boot: create the session branch locally. Nothing
  // pushes it, so origin never learns about it.
  git(['checkout', '-b', SESSION_ID], work)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function cfg(): Config {
  // No apiUrl/workspaceId/sandboxToken, so credential resolution short-circuits
  // and this stays offline.
  return {
    projectTarget: work,
    branchName: SESSION_ID,
    defaultBranch: 'main',
    repoUrl: origin,
  } as unknown as Config
}

describe('refreshRepo with an unpushed session branch', () => {
  test('does not throw — there is simply nothing upstream to pull', async () => {
    // Before the fix this rejected with
    // `git fetch refresh failed: fatal: couldn't find remote ref …`.
    const result = await refreshRepo(cfg())
    expect(result.before.commit).toBeTruthy()
    expect(result.after.commit).toBe(result.before.commit)
  })

  test('the session keeps its own commits', async () => {
    writeFileSync(join(work, 'agent-work.txt'), 'work\n')
    git(['add', '.'], work)
    git(['-c', 'user.email=a@k.dev', '-c', 'user.name=A', 'commit', '-m', 'agent work'], work)
    const head = gitOut(['rev-parse', 'HEAD'], work)

    await refreshRepo(cfg())

    expect(gitOut(['rev-parse', 'HEAD'], work)).toBe(head)
    expect(gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], work)).toBe(SESSION_ID)
  })

  test('a branch that IS on the remote still fast-forwards', async () => {
    // The tolerance must be specific to a missing ref. If it swallowed real
    // fetch failures, refresh would silently stop pulling for every session.
    git(['push', '-u', 'origin', SESSION_ID], work)

    const other = join(root, 'other')
    git(['clone', '--branch', SESSION_ID, origin, other])
    writeFileSync(join(other, 'upstream.txt'), 'from elsewhere\n')
    git(['add', '.'], other)
    git(['-c', 'user.email=b@k.dev', '-c', 'user.name=B', 'commit', '-m', 'upstream'], other)
    git(['push', 'origin', SESSION_ID], other)
    const expected = gitOut(['rev-parse', 'HEAD'], other)

    const result = await refreshRepo(cfg())

    expect(gitOut(['rev-parse', 'HEAD'], work)).toBe(expected)
    expect(result.after.commit).toBe(expected)
  })

  test('a genuine fetch failure is still fatal', async () => {
    // Point at a remote that does not exist. Swallowing this would hide a real
    // outage behind a refresh that reports success.
    const broken = { ...cfg(), repoUrl: join(root, 'no-such-repo.git') } as Config
    await expect(refreshRepo(broken)).rejects.toThrow(/git fetch refresh failed/)
  })
})
