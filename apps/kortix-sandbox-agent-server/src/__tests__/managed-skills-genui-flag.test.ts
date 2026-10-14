/**
 * The kortix-genui managed skill exists in a session only while the project's `genui` flag is on.
 *
 * A permission deny cannot hide it on OpenCode: the project's own config layer merges after the
 * composed config and its `"*": "allow"` rule outranks every `skill` rule (a flag-off session loaded
 * the skill and answered in generative UI, 2026-10-14). So the overlay does not write the skill, and
 * removes a copy an earlier flag-on boot left.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureInjectedManagedSkills, syncFlaggedManagedSkills } from '@/services/skills/managed-skills'

const roots: string[] = []

async function fixture(): Promise<{ bakedDir: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'genui-overlay-'))
  roots.push(root)
  const bakedDir = join(root, 'baked')
  const configDir = join(root, 'config')
  for (const name of ['kortix-cli', 'kortix-genui']) {
    await mkdir(join(bakedDir, name), { recursive: true })
    await writeFile(join(bakedDir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  }
  await mkdir(configDir, { recursive: true })
  return { bakedDir, configDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('the kortix-genui managed skill follows the genui flag', () => {
  test('flag off: the overlay writes every managed skill except kortix-genui', async () => {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: { KORTIX_GENUI: '0' } })
    expect(existsSync(join(configDir, 'skills', 'kortix-cli', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(configDir, 'skills', 'kortix-genui'))).toBe(false)
  })

  test('flag off: a copy a flag-on boot injected earlier is removed', async () => {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: { KORTIX_GENUI: '1' } })
    expect(existsSync(join(configDir, 'skills', 'kortix-genui', 'SKILL.md'))).toBe(true)
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: {} })
    expect(existsSync(join(configDir, 'skills', 'kortix-genui'))).toBe(false)
  })

  test('flag on: kortix-genui is written with the rest', async () => {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: { KORTIX_GENUI: '1' } })
    expect(existsSync(join(configDir, 'skills', 'kortix-genui', 'SKILL.md'))).toBe(true)
  })
})

// A config release is staged once and reused: a copy an older daemon put there survives restarts, so
// every OpenCode spawn removes it from the directory OpenCode reads.
describe('a reused config dir loses a kortix-genui copy while the flag is off', () => {
  async function skillsDirWithGenui(): Promise<string> {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: { KORTIX_GENUI: '1' } })
    return join(configDir, 'skills')
  }

  test('flag off: removed, and the rest stays', async () => {
    const skillsDir = await skillsDirWithGenui()
    await syncFlaggedManagedSkills(skillsDir, { env: { KORTIX_GENUI: '0' } })
    expect(existsSync(join(skillsDir, 'kortix-genui'))).toBe(false)
    expect(existsSync(join(skillsDir, 'kortix-cli', 'SKILL.md'))).toBe(true)
  })

  test('flag on: kept', async () => {
    const skillsDir = await skillsDirWithGenui()
    await syncFlaggedManagedSkills(skillsDir, { env: { KORTIX_GENUI: '1' } })
    expect(existsSync(join(skillsDir, 'kortix-genui', 'SKILL.md'))).toBe(true)
  })

  test('flag on: a reused dir that lacks the skill gets it back from the baked copy', async () => {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: { KORTIX_GENUI: '0' } })
    const skillsDir = join(configDir, 'skills')
    expect(existsSync(join(skillsDir, 'kortix-genui'))).toBe(false)
    await syncFlaggedManagedSkills(skillsDir, { env: { KORTIX_GENUI: '1' }, bakedDir })
    expect(existsSync(join(skillsDir, 'kortix-genui', 'SKILL.md'))).toBe(true)
  })

  test('a sealed release dir: removed, and the seal is put back', async () => {
    const skillsDir = await skillsDirWithGenui()
    await chmod(skillsDir, 0o555)
    try {
      await syncFlaggedManagedSkills(skillsDir, { env: {}, unseal: true })
      expect(existsSync(join(skillsDir, 'kortix-genui'))).toBe(false)
      expect((await stat(skillsDir)).mode & 0o200).toBe(0)
    } finally {
      await chmod(skillsDir, 0o755)
    }
  })
})
