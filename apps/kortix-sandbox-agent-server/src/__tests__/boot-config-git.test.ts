/**
 * The converged OpenCode config lives OUTSIDE the repository.
 *
 * Until 2026-09-18 a config reload wrote the base branch's `.kortix/opencode`
 * into the session's tracked working tree. Measured consequences: an agent's
 * `git add -A` swept those bytes into a session commit, the change request then
 * listed the agent prompt as "modified by the session", and the merge CONFLICTED
 * on a file nobody in the session had touched. Every guard that tried to tell
 * the platform's writes from the session's was a symptom of that one decision.
 *
 * So the platform never writes `/workspace`. It extracts the config dir at an
 * exact commit into its own directory, makes it read-only, and proves it is
 * intact before every spawn. Real git repositories, because extraction and
 * verification are properties of git's object store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateBootConfig,
  deactivateBootConfig,
  materializeBootConfig,
  pruneBootConfigs,
  readBootConfigPointer,
  verifyBootConfig,
} from '../boot-config-git'

const REL = '.kortix/opencode'
let root: string
let repo: string
let store: string
let overlay: string

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}
function write(rel: string, body: string, mode?: number) {
  mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(repo, rel), body)
  if (mode) chmodSync(join(repo, rel), mode)
}
function commit(message: string): string {
  git('add', '-A')
  git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const input = (sha: string) => ({ repo, sha, relConfigDir: REL, root: store, managedSkillsDir: overlay })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-boot-config-'))
  repo = join(root, 'repo')
  store = join(root, 'store')
  overlay = join(root, 'managed-skills')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(overlay, 'kortix-cli'), { recursive: true })
  writeFileSync(join(overlay, 'kortix-cli', 'SKILL.md'), 'OVERLAY\n')
  git('init', '--initial-branch=main', '--quiet')
  git('config', 'user.email', 't@t.co')
  git('config', 'user.name', 'T')
  write(`${REL}/opencode.jsonc`, '{}\n')
  write(`${REL}/agents/kortix.md`, 'PROMPT v1\n')
  write(`${REL}/skills/pdf/SKILL.md`, 'PDF\n')
  write(`${REL}/skills/pdf/scripts/run.sh`, '#!/bin/sh\necho hi\n', 0o755)
  write(`${REL}/skills/kortix-cli/SKILL.md`, 'STALE REPO COPY\n')
  write(`${REL}/package.json`, '{"dependencies":{"@opencode-ai/plugin":"1.17.11"}}\n')
  write('app.ts', 'export const x = 1\n')
})

afterEach(() => {
  spawnSync('chmod', ['-R', 'u+w', root])
  rmSync(root, { recursive: true, force: true })
})

describe('materializeBootConfig', () => {
  test('extracts the config dir at an exact commit, and nothing else', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))

    expect(dir.startsWith(store)).toBe(true)
    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
    expect(readFileSync(join(dir, 'skills/pdf/SKILL.md'), 'utf8')).toBe('PDF\n')
    expect(existsSync(join(dir, 'app.ts'))).toBe(false)
    expect(existsSync(join(dir, '.kortix'))).toBe(false)
  })

  test('it reads the COMMIT, not the working tree', async () => {
    const sha = commit('v1')
    write(`${REL}/agents/kortix.md`, 'UNCOMMITTED SESSION EDIT\n')

    const { dir } = await materializeBootConfig(input(sha))

    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
  })

  test('it never writes the repository', async () => {
    const sha = commit('v1')
    await materializeBootConfig(input(sha))

    expect(git('status', '--porcelain')).toBe('')
  })

  test('the project files are read-only, so an edit to the wrong copy fails loudly', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))

    expect(() => accessSync(join(dir, 'agents/kortix.md'), constants.W_OK)).toThrow()
    expect(() => writeFileSync(join(dir, 'agents/kortix.md'), 'x')).toThrow()
    // A script a skill ships stays executable.
    expect(() => accessSync(join(dir, 'skills/pdf/scripts/run.sh'), constants.X_OK)).not.toThrow()
  })

  test('what the platform itself writes stays writable', async () => {
    // opencode's installer rewrites the plugin pin and the lockfile at spawn,
    // and the runtime-assets pass re-injects the managed-skill overlay.
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))

    expect(() => accessSync(join(dir, 'package.json'), constants.W_OK)).not.toThrow()
    expect(() => accessSync(dir, constants.W_OK)).not.toThrow()
    expect(() => accessSync(join(dir, 'skills'), constants.W_OK)).not.toThrow()
  })

  test('the prepare hook runs on the staged directory before it is sealed', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig({
      ...input(sha),
      prepare: async (staged) => {
        writeFileSync(join(staged, 'skills/kortix-cli/SKILL.md'), 'OVERLAY\n')
      },
    })

    expect(readFileSync(join(dir, 'skills/kortix-cli/SKILL.md'), 'utf8')).toBe('OVERLAY\n')
  })

  test('the same commit is materialized once', async () => {
    const sha = commit('v1')
    const first = await materializeBootConfig(input(sha))
    let prepared = 0
    const second = await materializeBootConfig({ ...input(sha), prepare: async () => void prepared++ })

    expect(second.dir).toBe(first.dir)
    expect(prepared).toBe(0)
  })

  test('a commit without the config dir is refused, not extracted empty', async () => {
    rmSync(join(repo, '.kortix'), { recursive: true, force: true })
    const sha = commit('no config')

    await expect(materializeBootConfig(input(sha))).rejects.toThrow()
    // Nothing half-built is left where a later boot could adopt it.
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([])
  })

  test('a repo-controlled config dir cannot become an option or escape the tree', async () => {
    const sha = commit('v1')
    for (const relConfigDir of ['../outside', '--output=/tmp/x', '/etc', ':(top)*', 'a\nb']) {
      await expect(materializeBootConfig({ ...input(sha), relConfigDir })).rejects.toThrow()
    }
  })
})

describe('verifyBootConfig', () => {
  test('an untouched copy verifies', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))

    expect(await verifyBootConfig({ ...input(sha), dir })).toBe(true)
  })

  test('a tampered project file does not', async () => {
    // The agent runs as the same user as the daemon and has sudo, so read-only
    // is a guard against accidents, not a security boundary. THIS is the
    // guarantee: an edit to the copy never survives a spawn.
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))
    chmodSync(join(dir, 'agents/kortix.md'), 0o644)
    writeFileSync(join(dir, 'agents/kortix.md'), 'INJECTED PROMPT\n')

    expect(await verifyBootConfig({ ...input(sha), dir })).toBe(false)
  })

  test('a deleted project file does not', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))
    spawnSync('chmod', ['-R', 'u+w', dir])
    rmSync(join(dir, 'skills/pdf/SKILL.md'))

    expect(await verifyBootConfig({ ...input(sha), dir })).toBe(false)
  })

  test('an ADDED file is tampering too — opencode would load it', async () => {
    // Hashing only the committed files misses the cheapest attack there is:
    // drop a new agent, tool or second opencode.json next to them.
    const sha = commit('v1')
    for (const extra of ['agents/injected.md', 'tools/exfil.ts', 'opencode.json', 'skills/pdf/extra.md']) {
      const { dir } = await materializeBootConfig(input(sha))
      spawnSync('chmod', ['-R', 'u+w', dir])
      mkdirSync(join(dir, extra.split('/').slice(0, -1).join('/')), { recursive: true })
      writeFileSync(join(dir, extra), 'x')

      expect(await verifyBootConfig({ ...input(sha), dir })).toBe(false)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('what the platform writes is not tampering', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"@opencode-ai/plugin":"1.18.23"}}\n')
    writeFileSync(join(dir, 'bun.lock'), 'lock\n')
    mkdirSync(join(dir, 'node_modules/zod'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/zod/index.js'), '')
    spawnSync('chmod', ['-R', 'u+w', join(dir, 'skills/kortix-cli')])
    writeFileSync(join(dir, 'skills/kortix-cli/SKILL.md'), 'NEWER OVERLAY\n')

    expect(await verifyBootConfig({ ...input(sha), dir })).toBe(true)
  })

  test('the overlay the daemon injects by DEFAULT is not tampering', async () => {
    // #7403 preview, 2026-09-18: a second reload with nothing new answered
    // `updated` again. Production passes no `managedSkillsDir`; "undefined" was
    // read as "no managed skills", so the twelve `kortix-*` directories the
    // overlay injects counted as ADDED files, verification failed on every call
    // and the copy was silently re-extracted. Every unit test passed the dir
    // explicitly, so none of them could see it.
    const previous = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = overlay
    try {
      mkdirSync(join(overlay, 'kortix-system'), { recursive: true })
      writeFileSync(join(overlay, 'kortix-system', 'SKILL.md'), 'NOT IN THE REPO\n')
      const sha = commit('v1')
      const production = { repo, sha, relConfigDir: REL, root: store }
      const { dir } = await materializeBootConfig({
        ...production,
        prepare: async (staged) => {
          cpSync(overlay, join(staged, 'skills'), { recursive: true, force: true })
        },
      })

      expect(await verifyBootConfig({ ...production, dir })).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
      else process.env.KORTIX_MANAGED_SKILLS_DIR = previous
    }
  })

  test('a tracked symlink is compared by its target, never followed', async () => {
    symlinkSync('kortix.md', join(repo, `${REL}/agents/alias.md`))
    const sha = commit('symlink')
    const { dir } = await materializeBootConfig(input(sha))
    expect(await verifyBootConfig({ ...input(sha), dir })).toBe(true)

    spawnSync('chmod', ['u+w', join(dir, 'agents')])
    rmSync(join(dir, 'agents/alias.md'))
    symlinkSync('/etc/passwd', join(dir, 'agents/alias.md'))
    expect(await verifyBootConfig({ ...input(sha), dir })).toBe(false)
  })
})

describe('the active pointer', () => {
  test('survives a daemon restart and names the commit', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))
    expect(await readBootConfigPointer(store)).toBeNull()

    await activateBootConfig(store, { sha, relConfigDir: REL, dir })

    expect(await readBootConfigPointer(store)).toEqual({ sha, relConfigDir: REL, dir })
  })

  test('a pointer outside the store, or with a malformed commit, is ignored', async () => {
    mkdirSync(store, { recursive: true })
    for (const pointer of [
      { sha: 'a'.repeat(40), relConfigDir: REL, dir: '/etc' },
      { sha: 'not-a-sha', relConfigDir: REL, dir: join(store, 'x') },
      { sha: 'a'.repeat(40), relConfigDir: REL, dir: join(store, '..', 'escape') },
    ]) {
      writeFileSync(join(store, 'current.json'), JSON.stringify(pointer))
      expect(await readBootConfigPointer(store)).toBeNull()
    }
    writeFileSync(join(store, 'current.json'), '{not json')
    expect(await readBootConfigPointer(store)).toBeNull()
  })

  test('deactivating returns the box to the workspace floor', async () => {
    const sha = commit('v1')
    const { dir } = await materializeBootConfig(input(sha))
    await activateBootConfig(store, { sha, relConfigDir: REL, dir })

    await deactivateBootConfig(store)

    expect(await readBootConfigPointer(store)).toBeNull()
  })

  test('pruning keeps the named copies and removes the read-only rest', async () => {
    const first = await materializeBootConfig(input(commit('v1')))
    write(`${REL}/agents/kortix.md`, 'PROMPT v2\n')
    const second = await materializeBootConfig(input(commit('v2')))
    write(`${REL}/agents/kortix.md`, 'PROMPT v3\n')
    const third = await materializeBootConfig(input(commit('v3')))

    await pruneBootConfigs(store, [second.dir, third.dir])

    expect(existsSync(first.dir)).toBe(false)
    expect(existsSync(second.dir)).toBe(true)
    expect(existsSync(third.dir)).toBe(true)
  })
})
