import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureOpencodeConfigDeps } from '../harness/open-code/opencode-config-deps'

const STARTER_GITIGNORE = join(import.meta.dir, '../../../../packages/starter/templates/base/.gitignore')

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
    // The starter template's own ignore rules: they must cover the sentinel
    // and the dependency tree, so a template change that drops either rule
    // fails here rather than dirtying every session checkout.
    await writeFile(join(repo, '.gitignore'), await readFile(STARTER_GITIGNORE, 'utf8'))
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
      // The linked path leaves a `node_modules` SYMLINK, which the starter's
      // `node_modules/` rule (directories only) does not match. What hides it
      // is the `.gitignore` OpenCode writes into its config dir on config load
      // (claim carried from the original fixture; not verified against the
      // pinned OpenCode — tracked as a follow-up). Model that write here, and
      // only here, so the staged rows above prove the template alone.
      await writeFile(join(configDir, '.gitignore'), 'node_modules\n')
      await git(repo, 'add', '.kortix/opencode/.gitignore')
      await git(repo, 'commit', '-qm', 'opencode config gitignore')

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

// A config RELEASE is the platform's own copy (/opt/kortix/config/<id>), not
// the user's tree. OpenCode is spawned on the boot link, a SYMLINK to it, and
// npm's Arborist re-extracts the whole node_modules tree when its root path is
// a symlink: 5.4–9.6 s instead of 1.85 s on a real 2-vCPU box for the
// old-starter dependency set (boot regression, 2026-09-22). The release is
// therefore prepared so OpenCode's installer has nothing to do.
describe('ensureOpencodeConfigDeps on a platform-owned release copy', () => {
  const oldStarter = {
    name: 'kortix-opencode-config',
    private: true,
    dependencies: {
      '@mendable/firecrawl-js': '^4.25.1',
      '@opencode-ai/plugin': '1.17.11',
      '@tavily/core': '^0.7.3',
      replicate: '^1.4.0',
    },
    overrides: { axios: '1.18.0', 'form-data': '4.0.6' },
  }

  async function makeRelease(pkg: object) {
    const root = await mkdtemp(join(tmpdir(), 'oc-deps-release-'))
    const configDir = join(root, 'release')
    const bakedDir = join(root, 'baked')
    await mkdir(configDir, { recursive: true })
    await mkdir(join(bakedDir, 'node_modules'), { recursive: true })
    await writeFile(join(configDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await writeFile(join(configDir, 'bun.lock'), '{"lockfileVersion":1,"project":true}\n')
    await writeFile(join(bakedDir, 'bun.lock'), '{"lockfileVersion":1,"baked":true}\n')
    await writeFile(
      join(bakedDir, 'package.json'),
      JSON.stringify({ dependencies: { ...oldStarter.dependencies, '@opencode-ai/plugin': '1.18.23' } }),
    )
    return { root, configDir, bakedDir }
  }

  /** A fake `bun install`: installs every dependency the staged package.json declares. */
  function installDeclared(seen: { pin?: unknown }, skip: string[] = []) {
    return async (stagingDir: string) => {
      const pkg = JSON.parse(await readFile(join(stagingDir, 'package.json'), 'utf8'))
      seen.pin = pkg.dependencies?.['@opencode-ai/plugin']
      for (const name of Object.keys(pkg.dependencies ?? {})) {
        if (skip.includes(name)) continue
        await mkdir(join(stagingDir, 'node_modules', name), { recursive: true })
        await writeFile(join(stagingDir, 'node_modules', name, 'package.json'), JSON.stringify({ name }))
      }
    }
  }

  it('pins the plugin to the baked binary version before installing, as OpenCode would', async () => {
    const { root, configDir, bakedDir } = await makeRelease(oldStarter)
    try {
      const seen: { pin?: unknown } = {}
      await ensureOpencodeConfigDeps(configDir, { bakedDir, install: installDeclared(seen), platformOwned: true })

      expect(seen.pin).toBe('1.18.23')
      const packageJson = JSON.parse(await readFile(join(configDir, 'package.json'), 'utf8'))
      expect(packageJson.dependencies['@opencode-ai/plugin']).toBe('1.18.23')
      expect(packageJson.overrides).toEqual(oldStarter.overrides)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the install sentinel for a customized dependency set once every name is installed', async () => {
    const { root, configDir, bakedDir } = await makeRelease(oldStarter)
    try {
      await ensureOpencodeConfigDeps(configDir, { bakedDir, install: installDeclared({}), platformOwned: true })

      const packageLock = JSON.parse(await readFile(join(configDir, 'package-lock.json'), 'utf8'))
      expect(packageLock.kortixOpenCodeInstallSentinel).toBe(1)
      expect(Object.keys(packageLock.packages[''].dependencies).sort()).toEqual([
        '@mendable/firecrawl-js',
        '@opencode-ai/plugin',
        '@tavily/core',
        'replicate',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps OpenCode’s installer when a declared dependency did not install', async () => {
    const { root, configDir, bakedDir } = await makeRelease(oldStarter)
    try {
      await ensureOpencodeConfigDeps(configDir, {
        bakedDir,
        install: installDeclared({}, ['replicate']),
        platformOwned: true,
      })

      expect(await exists(join(configDir, 'package-lock.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps OpenCode’s installer when the plugin is neither declared nor installed', async () => {
    const { root, configDir, bakedDir } = await makeRelease({ name: 'custom', dependencies: { replicate: '^1.4.0' } })
    try {
      await ensureOpencodeConfigDeps(configDir, { bakedDir, install: installDeclared({}), platformOwned: true })

      expect(await exists(join(configDir, 'package-lock.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a working-tree config exactly as before: no pin rewrite, no sentinel', async () => {
    const { root, configDir, bakedDir } = await makeRelease(oldStarter)
    try {
      const seen: { pin?: unknown } = {}
      await ensureOpencodeConfigDeps(configDir, { bakedDir, install: installDeclared(seen) })

      expect(seen.pin).toBe('1.17.11')
      const packageJson = JSON.parse(await readFile(join(configDir, 'package.json'), 'utf8'))
      expect(packageJson.dependencies['@opencode-ai/plugin']).toBe('1.17.11')
      expect(await exists(join(configDir, 'package-lock.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
