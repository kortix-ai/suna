import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureOpencodeConfigDeps } from '../opencode-config-deps'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('ensureOpencodeConfigDeps', () => {
  it('links baked node_modules when the project and baked locks match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'replicate'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"replicate":"^1.4.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      // node_modules is a symlink pointing at the baked tree…
      expect(await readlink(join(configDir, 'node_modules'))).toBe(join(bakedDir, 'node_modules'))
      // …and resolves through to the baked package.
      expect(await exists(join(configDir, 'node_modules', 'replicate'))).toBe(true)
      // The matching project lock remains in place for OpenCode's verification.
      expect(await exists(join(configDir, 'bun.lock'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('suppresses OpenCode plugin installation for the baked local tool ABI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'zod'), { recursive: true })
      await writeFile(
        join(configDir, 'package.json'),
        JSON.stringify({
          name: 'kortix-opencode-config',
          private: true,
          kortixToolAbi: 1,
          dependencies: { zod: '4.1.8' },
        }),
      )
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      const packageLock = JSON.parse(await readFile(join(configDir, 'package-lock.json'), 'utf8'))
      expect(packageLock.kortixOpenCodeInstallSentinel).toBe(1)
      expect(packageLock.packages[''].dependencies).toEqual({
        '@opencode-ai/plugin': '*',
        zod: '4.1.8',
      })
      const packageJson = JSON.parse(await readFile(join(configDir, 'package.json'), 'utf8'))
      expect(packageJson.dependencies).toEqual({ zod: '4.1.8' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not replace a user package lock for a customized config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      const userLock = '{"lockfileVersion":3,"packages":{"":{"dependencies":{"zod":"4.1.8"}}}}'
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'zod'), { recursive: true })
      await writeFile(
        join(configDir, 'package.json'),
        JSON.stringify({
          name: 'custom-config',
          private: true,
          kortixToolAbi: 1,
          dependencies: { zod: '4.1.8' },
        }),
      )
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(configDir, 'package-lock.json'), userLock)

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await readFile(join(configDir, 'package-lock.json'), 'utf8')).toBe(userLock)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not suppress installation when the local ABI declares another dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'zod'), { recursive: true })
      await writeFile(
        join(configDir, 'package.json'),
        JSON.stringify({
          name: 'custom-config',
          private: true,
          kortixToolAbi: 1,
          dependencies: { zod: '4.1.8', custom: '1.0.0' },
        }),
      )
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await exists(join(configDir, 'package-lock.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no-ops when the config dir declares no deps (no package.json)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(configDir, { recursive: true })
      await mkdir(join(bakedDir, 'node_modules'), { recursive: true })

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await exists(join(configDir, 'node_modules'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces a stale real node_modules tree when the baked lock matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'existing'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"replicate":"^1.4.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1}')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await readlink(join(configDir, 'node_modules'))).toBe(join(bakedDir, 'node_modules'))
      expect(await exists(join(configDir, 'node_modules', 'existing'))).toBe(false)
      expect(await exists(join(configDir, 'node_modules', 'baked-only'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('installs a mismatched lock in staging and atomically replaces the stale tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'stale'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"ajv":"^8.0.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"config":"new"}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"baked":"old"}')

      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: async (stagingDir) => {
          expect(await exists(join(configDir, 'node_modules', 'stale'))).toBe(true)
          await mkdir(join(stagingDir, 'node_modules', 'fresh'), { recursive: true })
        },
      })

      expect(await exists(join(configDir, 'node_modules', 'stale'))).toBe(false)
      expect(await exists(join(configDir, 'node_modules', 'fresh'))).toBe(true)
      expect(await exists(join(configDir, 'node_modules', 'baked-only'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a stale tree after staged installation fails so OpenCode installs cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      await mkdir(join(configDir, 'node_modules', 'stale'), { recursive: true })
      await mkdir(join(bakedDir, 'node_modules', 'baked-only'), { recursive: true })
      await writeFile(join(configDir, 'package.json'), '{"dependencies":{"ajv":"^8.0.0"}}')
      await writeFile(join(configDir, 'bun.lock'), '{"config":"new"}')
      await writeFile(join(bakedDir, 'bun.lock'), '{"baked":"old"}')

      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: async () => {
          throw new Error('offline cache miss')
        },
      })

      expect(await exists(join(configDir, 'node_modules'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * The defect this guards: a brand-new session showed
 * `M .kortix/opencode/package.json` in `git status` before the agent touched
 * anything. The config dir is inside the user's repository and its
 * `package.json` is TRACKED, so `.git/info/exclude` (the sibling fix for the
 * untracked managed skills) cannot hide it.
 *
 * Mechanism, read out of the shipped opencode binary (`Npm.install`):
 *   reify({ ...loaded, add: [{ name: '@opencode-ai/plugin' }], save: true,
 *           saveType: 'prod' })
 * runs whenever a declared name is absent from `package-lock.json`'s
 * `packages[""]`, and `save: true` writes the added dependency back into
 * `package.json`. The starter stopped declaring `@opencode-ai/plugin` in
 * 518699f0d0, so the write became a real diff.
 *
 * The staged-install path is the one the standard image always takes: the
 * baked dependency set is a superset of the lean local tool ABI, so
 * `filesMatch(configLock, bakedLock)` is never true there.
 */
describe('ensureOpencodeConfigDeps working-tree cleanliness', () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })
    return stdout
  }

  /** A real repo shaped like a session checkout of the starter template. */
  const makeSessionRepo = async (): Promise<{
    root: string
    repo: string
    configDir: string
    bakedDir: string
  }> => {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-git-'))
    // The baked tree is image state at /opt/kortix — never inside the repo.
    const bakedDir = join(root, 'baked')
    const repo = join(root, 'repo')
    const configDir = join(repo, '.kortix', 'opencode')
    await mkdir(configDir, { recursive: true })
    // packages/starter/templates/base/.gitignore ignores the sentinel; opencode
    // itself writes <configDir>/.gitignore covering node_modules on every config
    // load. Both are runtime state and must never be committed.
    await writeFile(join(repo, '.gitignore'), 'node_modules\n.kortix/opencode/package-lock.json\n')
    await writeFile(
      join(configDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'kortix-opencode-config',
          private: true,
          kortixToolAbi: 1,
          dependencies: { zod: '4.1.8' },
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1,"starter":true}\n')
    await git(repo, 'init', '-q')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'starter')
    expect(await git(repo, 'status', '--porcelain')).toBe('')
    return { root, repo, configDir, bakedDir }
  }

  it('writes the install sentinel on the staged path and leaves git status empty', async () => {
    const { root, repo, configDir, bakedDir } = await makeSessionRepo()
    try {
      await mkdir(join(bakedDir, 'node_modules', 'zod'), { recursive: true })
      // The baked set is a superset of the lean ABI, so the locks never match
      // and boot always falls through to the staged install.
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1,"baked":true}\n')

      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: async (stagingDir) => {
          await mkdir(join(stagingDir, 'node_modules', 'zod'), { recursive: true })
        },
      })

      // The dependency tree is really installed…
      expect(await exists(join(configDir, 'node_modules', 'zod'))).toBe(true)
      // …the sentinel that suppresses OpenCode's saving reify is present…
      const packageLock = JSON.parse(await readFile(join(configDir, 'package-lock.json'), 'utf8'))
      expect(packageLock.kortixOpenCodeInstallSentinel).toBe(1)
      expect(packageLock.packages[''].dependencies).toEqual({
        '@opencode-ai/plugin': '*',
        zod: '4.1.8',
      })
      // …and boot left the user's repository byte-for-byte clean.
      expect(await git(repo, 'status', '--porcelain')).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves git status empty on the linked baked path too', async () => {
    const { root, repo, configDir, bakedDir } = await makeSessionRepo()
    try {
      await mkdir(join(bakedDir, 'node_modules', 'zod'), { recursive: true })
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1,"starter":true}\n')

      await ensureOpencodeConfigDeps(configDir, { bakedDir })

      expect(await readlink(join(configDir, 'node_modules'))).toBe(join(bakedDir, 'node_modules'))
      const packageLock = JSON.parse(await readFile(join(configDir, 'package-lock.json'), 'utf8'))
      expect(packageLock.kortixOpenCodeInstallSentinel).toBe(1)
      expect(await git(repo, 'status', '--porcelain')).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not write a sentinel into a customized config on the staged path', async () => {
    const { root, repo, configDir, bakedDir } = await makeSessionRepo()
    try {
      await mkdir(join(bakedDir, 'node_modules', 'zod'), { recursive: true })
      await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1,"baked":true}\n')
      // A user-owned dependency set is not the versioned local tool ABI, so it
      // keeps OpenCode's normal installer.
      await writeFile(
        join(configDir, 'package.json'),
        `${JSON.stringify({ name: 'custom', dependencies: { zod: '4.1.8', ajv: '^8.0.0' } }, null, 2)}\n`,
      )
      await git(repo, 'commit', '-qam', 'customize')

      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: async (stagingDir) => {
          await mkdir(join(stagingDir, 'node_modules', 'zod'), { recursive: true })
        },
      })

      expect(await exists(join(configDir, 'package-lock.json'))).toBe(false)
      expect(await git(repo, 'status', '--porcelain')).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
