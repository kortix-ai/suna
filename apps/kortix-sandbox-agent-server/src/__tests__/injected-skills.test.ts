import { describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ensureInjectedManagedSkills } from '../injected-skills'

const execFileAsync = promisify(execFile)

/** A real git working tree — the exclude behaviour under test is git's, not ours. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function makeRepo(root: string): Promise<string> {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 'test@kortix.ai')
  await git(repo, 'config', 'user.name', 'test')
  await writeFile(join(repo, 'README.md'), 'hi\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'base')
  return repo
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('ensureInjectedManagedSkills', () => {
  it('overlays baked managed skills into the config dir, refreshing a stale repo copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inj-skills-'))
    try {
      const configDir = join(root, 'config')
      const bakedDir = join(root, 'baked')
      // Repo already has an OLD kortix-cli copy that must be overwritten.
      await mkdir(join(configDir, 'skills', 'kortix-cli'), { recursive: true })
      await writeFile(join(configDir, 'skills', 'kortix-cli', 'SKILL.md'), 'STALE OLD BODY')
      // Baked (image) has the current kortix-cli + a managed kortix-system skill.
      await mkdir(join(bakedDir, 'kortix-cli'), { recursive: true })
      await writeFile(join(bakedDir, 'kortix-cli', 'SKILL.md'), 'LATEST kortix-cli')
      await mkdir(join(bakedDir, 'kortix-system', 'references'), { recursive: true })
      await writeFile(join(bakedDir, 'kortix-system', 'SKILL.md'), 'LATEST kortix-system')
      await writeFile(join(bakedDir, 'kortix-system', 'references', 'cli.md'), 'ref')

      await ensureInjectedManagedSkills(configDir, { bakedDir })

      // Stale copy refreshed to the latest…
      expect(await readFile(join(configDir, 'skills', 'kortix-cli', 'SKILL.md'), 'utf8')).toBe(
        'LATEST kortix-cli',
      )
      // …a missing managed skill (with nested references) is restored in full.
      expect(await readFile(join(configDir, 'skills', 'kortix-system', 'SKILL.md'), 'utf8')).toBe(
        'LATEST kortix-system',
      )
      expect(await exists(join(configDir, 'skills', 'kortix-system', 'references', 'cli.md'))).toBe(
        true,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hides the injected skills from git status instead of dirtying the working tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inj-skills-'))
    try {
      const repo = await makeRepo(root)
      const configDir = join(repo, '.kortix', 'opencode')
      const bakedDir = join(root, 'baked')
      await mkdir(join(bakedDir, 'kortix-system', 'references'), { recursive: true })
      await writeFile(join(bakedDir, 'kortix-system', 'SKILL.md'), 'managed')
      await writeFile(join(bakedDir, 'kortix-system', 'references', 'cli.md'), 'ref')
      await mkdir(join(bakedDir, 'kortix-apps'), { recursive: true })
      await writeFile(join(bakedDir, 'kortix-apps', 'SKILL.md'), 'managed')

      await ensureInjectedManagedSkills(configDir, { bakedDir })

      // The bodies are on disk for opencode to load…
      expect(await readFile(join(configDir, 'skills', 'kortix-apps', 'SKILL.md'), 'utf8')).toBe(
        'managed',
      )
      // …and the session's change count — `git status --porcelain -uall`, the
      // exact command GET /file/status runs — is back to zero.
      expect(await git(repo, 'status', '--porcelain', '-uall')).toBe('')
      // `reload config` reads the config dir alone; it must be clean too.
      expect(await git(repo, 'status', '--porcelain', '--', '.kortix/opencode')).toBe('')
      const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
      expect(exclude).toContain('/.kortix/opencode/skills/kortix-apps/')
      expect(exclude).toContain('/.kortix/opencode/skills/kortix-system/')

      // Re-running a boot must not append the same entries again.
      await ensureInjectedManagedSkills(configDir, { bakedDir })
      expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude)

      // A file the USER writes next to them is still reported.
      await writeFile(join(configDir, 'skills', 'mine.md'), 'mine')
      expect(await git(repo, 'status', '--porcelain', '-uall')).toContain(
        '.kortix/opencode/skills/mine.md',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a committed copy of a managed skill visible — exclude never applies to tracked paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inj-skills-'))
    try {
      const repo = await makeRepo(root)
      const configDir = join(repo, '.kortix', 'opencode')
      const bakedDir = join(root, 'baked')
      // A pre-slim-down project: the managed body is TRACKED in the repo.
      await mkdir(join(configDir, 'skills', 'kortix-system'), { recursive: true })
      await writeFile(join(configDir, 'skills', 'kortix-system', 'SKILL.md'), 'OLD')
      await git(repo, 'add', '-A')
      await git(repo, 'commit', '-qm', 'committed managed skill')
      await mkdir(join(bakedDir, 'kortix-system'), { recursive: true })
      await writeFile(join(bakedDir, 'kortix-system', 'SKILL.md'), 'NEW')

      await ensureInjectedManagedSkills(configDir, { bakedDir })

      // The refresh still happens and is still reported as a real modification —
      // it is a change to a file the project committed, not boot noise.
      expect(await git(repo, 'status', '--porcelain', '-uall')).toContain(
        'M .kortix/opencode/skills/kortix-system/SKILL.md',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no-ops safely when the config dir is outside any git repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inj-skills-'))
    try {
      const configDir = join(root, 'ephemeral', 'opencode')
      const bakedDir = join(root, 'baked')
      await mkdir(join(bakedDir, 'kortix-cli'), { recursive: true })
      await writeFile(join(bakedDir, 'kortix-cli', 'SKILL.md'), 'body')
      await ensureInjectedManagedSkills(configDir, { bakedDir })
      expect(await readFile(join(configDir, 'skills', 'kortix-cli', 'SKILL.md'), 'utf8')).toBe(
        'body',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no-ops safely when the baked dir is absent (pre-bake image) and never throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inj-skills-'))
    try {
      const configDir = join(root, 'config')
      await mkdir(join(configDir, 'skills'), { recursive: true })
      // bakedDir does not exist → must be a silent no-op, not an error.
      await ensureInjectedManagedSkills(configDir, { bakedDir: join(root, 'nope') })
      // Nothing injected; the (empty) skills dir is untouched.
      expect(await exists(join(configDir, 'skills', 'kortix-cli'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
