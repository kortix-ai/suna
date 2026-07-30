import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureInjectedManagedSkills,
  managedSkillConfigDirs,
} from '../injected-skills'

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

describe('managedSkillConfigDirs', () => {
  it('returns every native project skill directory for the selected harness', () => {
    expect(
      managedSkillConfigDirs({
        workspace: '/workspace',
        opencodeConfigDir: '/workspace/.kortix/opencode',
        harness: 'claude',
        runtimeConfigDir: '.claude',
      }),
    ).toEqual([
      '/workspace/.kortix/opencode',
      '/workspace/.claude',
    ])

    expect(
      managedSkillConfigDirs({
        workspace: '/workspace',
        opencodeConfigDir: '/workspace/.kortix/opencode',
        harness: 'codex',
        runtimeConfigDir: '.codex',
      }),
    ).toEqual([
      '/workspace/.kortix/opencode',
      '/workspace/.agents',
    ])

    expect(
      managedSkillConfigDirs({
        workspace: '/workspace',
        opencodeConfigDir: '/workspace/.kortix/opencode',
        harness: 'pi',
        runtimeConfigDir: '.pi',
      }),
    ).toEqual([
      '/workspace/.kortix/opencode',
      '/workspace/.pi',
    ])
  })

  it('deduplicates OpenCode and resolves an absolute runtime config directory', () => {
    expect(
      managedSkillConfigDirs({
        workspace: '/workspace',
        opencodeConfigDir: '/workspace/.kortix/opencode',
        harness: 'opencode',
        runtimeConfigDir: '/workspace/.kortix/opencode',
      }),
    ).toEqual(['/workspace/.kortix/opencode'])
  })

  it('excludes the OpenCode directory from a non-OpenCode harness boot', () => {
    expect(
      managedSkillConfigDirs({
        workspace: '/workspace',
        opencodeConfigDir: '/workspace/.kortix/opencode',
        harness: 'pi',
        runtimeConfigDir: '.pi',
        includeOpenCode: false,
      }),
    ).toEqual(['/workspace/.pi'])
  })
})
