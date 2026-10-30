/**
 * `POST /kortix/refresh` through the full daemon app (`buildDaemonApp`) over the
 * production pi control, with real `git` repositories. The pi runtime is a
 * stub: refresh reads only its state and its skill reload.
 *
 * - Auth: a signed user context, or the sandbox bearer.
 * - Repo work: pull, and the no-op when the session branch is not on the remote.
 * - The route: one refresh at a time.
 * - Runtime-assets convergence never runs while the runtime is still booting.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

import type { Config } from '@/lib/config/config'
import type { HarnessControlService, HarnessRefreshInput } from '@/harness/contract/control'
import { buildDaemonApp } from '@/app/server'
import { createPiConfigReleases } from '@/harness/pi/config-release'
import { createPiControlService } from '@/harness/pi/control'
import type { PiRuntime } from '@/harness/pi/runtime'
import { KORTIX_SERVICE_CALL_HEADER, KORTIX_USER_CONTEXT_HEADER } from '@/lib/kortix-api/kortix-user-context'
import {
  fakeHarness,
  signTestUserContext,
  TEST_SANDBOX_TOKEN,
  testConfig,
} from './helpers/daemon-test-app'
import { resolveHarness } from '@/harness/harness'
import { __resetReconcileCooldownForTests, registerHarnessAssets, resetHarnessAssetsForTests } from '@/services/runtime-assets/runtime-assets'

// Production registers this lookup in main.ts before anything runs.
beforeAll(() => registerHarnessAssets((cfg) => resolveHarness(cfg).assets))
afterAll(() => resetHarnessAssetsForTests())

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

/**
 * The production pi control over a runtime stub in `state` (null: never
 * started). `onRefresh` sees every refresh before the control runs it.
 */
function piControl(
  cfg: Config,
  opts: { state?: 'ok' | 'starting' | 'down' | null; onRefresh?: (input: HarnessRefreshInput) => Promise<void> | void } = {},
): HarnessControlService {
  const runtime = opts.state ? ({ getState: () => opts.state, reloadSkills: async () => {} } as unknown as PiRuntime) : null
  const control = createPiControlService(() => runtime, createPiConfigReleases({ cfg, env: {} }), () => {})
  if (!opts.onRefresh) return control
  return {
    ...control,
    bind: (context) => {
      const operations = control.bind(context)
      return {
        ...operations,
        refresh: async (input) => {
          await opts.onRefresh!(input)
          return operations.refresh(input)
        },
      }
    },
  }
}

function app(over: Partial<Config>, opts: Parameters<typeof piControl>[1] = {}) {
  const cfg = testConfig(over)
  return buildDaemonApp(cfg, fakeHarness({ control: piControl(cfg, opts) }), Date.now())
}

/** An empty, repo-less project target. `/workspace` (the fixture default) is a
 *  real git checkout on a Kortix sandbox, where the "no repo here" 409 the
 *  auth tests assert would instead run the repo work. */
function emptyTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-refresh-empty-'))
  roots.push(dir)
  return dir
}

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
  it('refreshes a materialized repo whose config names no repoUrl', async () => {
    // The credential boundary refuses a CONFIGURED non-proxy origin; a repo
    // with no repoUrl in env must not 500 on that refusal — the checkout's
    // own file origin answers. Red-witnesses resolveCloneCredential: before
    // the unset-repoUrl early return, this route answered 500.
    const { worktree } = clonedRepo()
    const res = await app({ projectTarget: worktree }).request('/kortix/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_SANDBOX_TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('keeps an ordinary refresh open to a proxied caller', async () => {
    // Only the destructive flag needs the direct call: a user pulling their own
    // workspace keeps working without it. No repo here, so the repo work
    // answers 409; the gate did not refuse it.
    const res = await app({ projectTarget: emptyTarget() }).request('/kortix/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_SANDBOX_TOKEN}` },
    })
    expect(res.status).toBe(409)
  })

})

describe('repo work and the route', () => {
  it('pulls the project repo, reporting the commits before and after', async () => {
    const repo = clonedRepo()
    commit(repo.seed, 'v2\n')
    git(['push', '-q', 'origin', 'main'], repo.seed)

    const res = await app(
      { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' },
    ).request('/kortix/refresh', { method: 'POST', headers: USER() })

    expect(res.status).toBe(200)
    expect(readFileSync(join(repo.worktree, 'README.md'), 'utf8')).toBe('v2\n')
    const body = (await res.json()) as {
      ok: boolean
      repo: { before: { commit: string }; after: { commit: string } }
    }
    expect(body.ok).toBe(true)
    expect(body.repo.before.commit).not.toBe(body.repo.after.commit)
  })

  it('answers 409 to a second refresh while one is running', async () => {
    const repo = clonedRepo()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    const daemon = app(
      { projectTarget: repo.worktree, repoUrl: repo.remote, branchName: 'main' },
      { onRefresh: async () => { started += 1; await held } },
    )

    const first = daemon.request('/kortix/refresh', { method: 'POST', headers: USER() })
    // The first request is past the gate once its refresh is pending.
    const deadline = Date.now() + 10_000
    while (started === 0 && Date.now() < deadline) await Bun.sleep(10)
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

})

describe('runtime-assets convergence after a refresh', () => {
  // The session-open refresh used to install a new runtime and restart it
  // underneath a resume that was still booting (the API's start budget then
  // expired). A refresh converges only a runtime that is already serving.
  const saved = { url: process.env.KORTIX_API_URL, token: process.env.KORTIX_TOKEN }

  // The cooldown is module state: a pass another test file converged in the last
  // 60 s makes the refresh skip its own pass, so the `ok` row read nothing.
  beforeEach(() => __resetReconcileCooldownForTests())

  afterEach(() => {
    if (saved.url === undefined) delete process.env.KORTIX_API_URL
    else process.env.KORTIX_API_URL = saved.url
    if (saved.token === undefined) delete process.env.KORTIX_TOKEN
    else process.env.KORTIX_TOKEN = saved.token
  })

  it.each([
    [null, 0],
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
        { state },
      ).request('/kortix/refresh', { method: 'POST', headers: USER() })
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
