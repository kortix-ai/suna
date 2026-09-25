/**
 * `POST /kortix/refresh` through the full daemon app (`buildDaemonApp` over the
 * production harness composition), with real `git` repositories and a fake
 * OpenCode lifecycle.
 *
 * - Auth: a signed user context, or the sandbox bearer. `base=1` (a branch
 *   reset that discards the session's commits) additionally needs the
 *   direct-call header, because the preview proxy authenticates the user
 *   traffic it relays with the same bearer.
 * - Repo work: pull, base checkout, the no-op when HEAD is already base.
 * - Reload: a verified swap by default, none with `restart=0`, fault injection
 *   only on `verify_fail=1`, and the outcome on the wire.
 * - Runtime-assets convergence never runs while OpenCode is still booting.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import type { Opencode, VerifiedReloadResult } from '../harness/open-code/lifecycle'
import { KORTIX_SERVICE_CALL_HEADER, KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import {
  buildOpenCodeTestApp,
  signTestUserContext,
  TEST_SANDBOX_TOKEN,
  testOpenCodeConfig,
} from './helpers/open-code-harness'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Kortix Test',
      GIT_AUTHOR_EMAIL: 'test@kortix.dev',
      GIT_COMMITTER_NAME: 'Kortix Test',
      GIT_COMMITTER_EMAIL: 'test@kortix.dev',
    },
  }).trim()
}

function commit(dir: string, content: string): string {
  writeFileSync(join(dir, 'README.md'), content)
  git(['add', 'README.md'], dir)
  git(['commit', '-q', '-m', content.trim()], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

/** A bare remote with `main` at v1, a clone of it, and the seed that pushes. */
function clonedRepo(): { root: string; remote: string; seed: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'kortix-refresh-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const worktree = join(root, 'worktree')
  git(['init', '-q', '--bare', remote])
  mkdirSync(seed)
  git(['init', '-q', '-b', 'main'], seed)
  commit(seed, 'v1\n')
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-q', '-u', 'origin', 'main'], seed)
  git(['clone', '-q', remote, worktree])
  return { root, remote, seed, worktree }
}

interface FakeLifecycle {
  opencode: Opencode
  reloads: Array<{ forceFail?: boolean }>
}

function fakeOpencode(
  opts: {
    state?: 'ok' | 'starting' | 'down'
    reload?: (forceFail?: boolean) => Promise<VerifiedReloadResult>
  } = {},
): FakeLifecycle {
  const reloads: FakeLifecycle['reloads'] = []
  const opencode = {
    // 'starting' by default: a serving runtime schedules a detached
    // runtime-assets pass after each refresh, which would outlive its row.
    getState: () => opts.state ?? 'starting',
    getPid: () => 1,
    getInternalUrl: () => 'http://127.0.0.1:1',
    getActivePort: () => 4096,
    reloadVerified: async (reloadOpts: { forceFail?: boolean } = {}) => {
      reloads.push(reloadOpts)
      return opts.reload
        ? opts.reload(reloadOpts.forceFail)
        : { outcome: 'swapped' as const, port: 4097, pid: 2, turnEnded: false }
    },
  } as unknown as Opencode
  return { opencode, reloads }
}

function app(cfg: Partial<Config>, lifecycle: FakeLifecycle = fakeOpencode()) {
  return buildOpenCodeTestApp(testOpenCodeConfig(cfg), lifecycle.opencode, Date.now())
}

const SERVICE = { Authorization: `Bearer ${TEST_SANDBOX_TOKEN}`, [KORTIX_SERVICE_CALL_HEADER]: '1' }
const USER = () => ({
  [KORTIX_USER_CONTEXT_HEADER]: signTestUserContext(
    { userId: 'u', sandboxId: 's', sandboxRole: 'owner' },
    TEST_SANDBOX_TOKEN,
  ),
})

describe('auth', () => {
  it('rejects a request with no signed user context and no bearer', async () => {
    const res = await app({}).request('/kortix/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'malformed' })
  })

  // What the preview proxy sends for an ordinary user: the sandbox's own
  // bearer and NO direct-call header (it strips that name from every forward).
  // The first version of this gate accepted it and protected nothing.
  it('refuses base=1 from a request shaped like a proxied user request', async () => {
    const res = await app({}).request('/kortix/refresh?base=1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_SANDBOX_TOKEN}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'BASE_RESET_FORBIDDEN' })
  })

  it('does not accept the direct-call header alone for base=1', async () => {
    // The header proves the hop, never the caller.
    const res = await app({}).request('/kortix/refresh?base=1', {
      method: 'POST',
      headers: { [KORTIX_SERVICE_CALL_HEADER]: '1' },
    })
    expect(res.status).toBe(401)
  })

  it('lets a direct API call with both proofs reach the repo work for base=1', async () => {
    // No repo here, so the repo work answers 409; the gate did not refuse it.
    const res = await app({}).request('/kortix/refresh?base=1&restart=0', { method: 'POST', headers: SERVICE })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('refresh failed')
    expect(body.message).toContain('not materialized')
  })

  it('keeps an ordinary refresh open to a proxied caller', async () => {
    // Only the destructive flag needs the direct call: a user pulling their own
    // workspace and the API's `config_dir=1` reload keep working without it.
    for (const path of ['/kortix/refresh', '/kortix/refresh?restart=0&config_dir=1']) {
      const res = await app({}).request(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_SANDBOX_TOKEN}` },
      })
      expect(res.status).toBe(409)
    }
  })

  it('rejects an invalid base_sha before any Git execution', async () => {
    const res = await app({}).request('/kortix/refresh?base=1&base_sha=main', { method: 'POST', headers: SERVICE })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid base_sha' })
  })
})

describe('repo work and reload', () => {
  it('pulls the project repo and replaces OpenCode once, reporting the swap', async () => {
    const repo = clonedRepo()
    commit(repo.seed, 'v2\n')
    git(['push', '-q', 'origin', 'main'], repo.seed)
    const lifecycle = fakeOpencode()

    const res = await app(
      { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' },
      lifecycle,
    ).request('/kortix/refresh', { method: 'POST', headers: USER() })

    expect(res.status).toBe(200)
    expect(readFileSync(join(repo.worktree, 'README.md'), 'utf8')).toBe('v2\n')
    expect(lifecycle.reloads).toHaveLength(1)
    expect(lifecycle.reloads[0]!.forceFail).toBeFalsy()
    const body = (await res.json()) as {
      ok: boolean
      repo: { before: { commit: string }; after: { commit: string } }
      reload: { outcome: string; port: number }
    }
    expect(body.ok).toBe(true)
    expect(body.repo.before.commit).not.toBe(body.repo.after.commit)
    expect(body.reload).toMatchObject({ outcome: 'swapped', port: 4097 })
  })

  it('a declined swap still reports the repo work as ok, with the reason', async () => {
    // The pull succeeded; the reload safely kept the running OpenCode. Hiding
    // the pull behind ok:false would lie about the repo.
    const repo = clonedRepo()
    const lifecycle = fakeOpencode({
      reload: async () => ({ outcome: 'kept-old', reason: 'the new opencode did not start' }),
    })

    const res = await app(
      { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' },
      lifecycle,
    ).request('/kortix/refresh', { method: 'POST', headers: USER() })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      reload: { outcome: 'kept-old', reason: 'the new opencode did not start' },
    })
  })

  it('injects a verification failure only on an explicit verify_fail=1', async () => {
    const repo = clonedRepo()
    const lifecycle = fakeOpencode()
    const refresh = (query: string) =>
      app({ projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' }, lifecycle).request(
        `/kortix/refresh${query}`,
        { method: 'POST', headers: USER() },
      )

    expect((await refresh('?verify_fail=true')).status).toBe(200)
    expect((await refresh('?verify_fail=1')).status).toBe(200)

    expect(lifecycle.reloads.map((opts) => opts.forceFail === true)).toEqual([false, true])
  })

  it('answers 409 to a second refresh while one is running', async () => {
    const repo = clonedRepo()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const lifecycle = fakeOpencode({
      reload: async () => {
        await held
        return { outcome: 'swapped', port: 4097, pid: 2, turnEnded: false }
      },
    })
    const daemon = app({ projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' }, lifecycle)

    const first = daemon.request('/kortix/refresh', { method: 'POST', headers: USER() })
    // The first request is past the gate once its reload is pending.
    const deadline = Date.now() + 10_000
    while (lifecycle.reloads.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    const second = await daemon.request('/kortix/refresh', { method: 'POST', headers: USER() })
    release()

    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'refresh already running' })
    expect((await first).status).toBe(200)
  })

  it('answers 409 when the fast-forward pull fails', async () => {
    // The session committed on top of an old base while the base moved: the
    // pull cannot fast-forward.
    const repo = clonedRepo()
    commit(repo.seed, 'v2\n')
    git(['push', '-q', 'origin', 'main'], repo.seed)
    commit(repo.worktree, 'local work\n')

    const res = await app(
      { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' },
    ).request('/kortix/refresh', { method: 'POST', headers: USER() })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { message: string }).message).toContain('git pull refresh failed')
  })

  it('skips the base fetch when the workspace already matches base_sha', async () => {
    // A missing remote proves no network was attempted.
    const root = mkdtempSync(join(tmpdir(), 'kortix-refresh-unchanged-'))
    roots.push(root)
    const worktree = join(root, 'worktree')
    mkdirSync(worktree)
    git(['init', '-q', '-b', 'session-branch'], worktree)
    const baseSha = commit(worktree, 'current\n')

    const res = await app({
      projectTarget: worktree,
      repoUrl: join(root, 'missing-remote.git'),
      branchName: 'session-branch',
    }).request(`/kortix/refresh?base=1&base_sha=${baseSha}&restart=0`, { method: 'POST', headers: SERVICE })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      repo: { before: { commit: baseSha }, after: { commit: baseSha } },
    })
  })

  it('checks out the exact base_sha, and restart=0 replaces nothing', async () => {
    const repo = clonedRepo()
    const baseSha = commit(repo.seed, 'v2\n')
    commit(repo.seed, 'v3\n')
    git(['push', '-q', 'origin', 'main'], repo.seed)
    const lifecycle = fakeOpencode()

    const res = await app(
      { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'session-branch' },
      lifecycle,
    ).request(`/kortix/refresh?base=1&base_sha=${baseSha}&restart=0`, { method: 'POST', headers: SERVICE })

    expect(res.status).toBe(200)
    expect(readFileSync(join(repo.worktree, 'README.md'), 'utf8')).toBe('v2\n')
    expect(git(['rev-parse', 'HEAD'], repo.worktree)).toBe(baseSha)
    expect(lifecycle.reloads).toHaveLength(0)
  })
})

describe('runtime-assets convergence after a refresh', () => {
  // The session-open refresh used to install a new OpenCode and restart it
  // underneath a resume that was still booting (the API's start budget then
  // expired). A refresh converges only a runtime that is already serving.
  const saved = { url: process.env.KORTIX_API_URL, token: process.env.KORTIX_TOKEN }

  afterEach(() => {
    if (saved.url === undefined) delete process.env.KORTIX_API_URL
    else process.env.KORTIX_API_URL = saved.url
    if (saved.token === undefined) delete process.env.KORTIX_TOKEN
    else process.env.KORTIX_TOKEN = saved.token
  })

  it.each([
    ['starting', 0],
    ['down', 0],
    ['ok', 1],
  ] as const)('a %s runtime triggers %i runtime-assets manifest read(s)', async (state, expected) => {
    const manifestReads: string[] = []
    const api = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.includes('/runtime-assets')) manifestReads.push(path)
        // No manifest: the pass ends before it could install anything.
        return new Response('not found', { status: 404 })
      },
    })
    try {
      process.env.KORTIX_API_URL = `http://127.0.0.1:${api.port}/v1`
      process.env.KORTIX_TOKEN = 'sandbox-token'
      const repo = clonedRepo()

      const res = await app(
        { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' },
        fakeOpencode({ state }),
      ).request('/kortix/refresh?restart=0', { method: 'POST', headers: USER() })
      expect(res.status).toBe(200)

      const deadline = Date.now() + 2_000
      while (manifestReads.length < expected && Date.now() < deadline) await Bun.sleep(20)
      await Bun.sleep(200)
      expect(manifestReads).toHaveLength(expected)
    } finally {
      api.stop(true)
    }
  })
})
