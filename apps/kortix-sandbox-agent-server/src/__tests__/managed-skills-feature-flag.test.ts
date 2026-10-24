/**
 * A managed skill whose frontmatter names a project feature flag
 * (`metadata.kortix-feature-flag`) exists in a session only while that flag is
 * on. The API lists the project's enabled flags in KORTIX_FEATURE_FLAGS.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enabledFeatureFlags, skillFeatureFlag } from '@/lib/config/feature-flags'
import { ensureInjectedManagedSkills, syncFlaggedManagedSkills, withheldManagedSkills } from '@/services/skills/managed-skills'

const roots: string[] = []

const ROOMS_SKILL = '---\nname: kortix-rooms\ndescription: "Chat rooms."\nmetadata:\n  kortix-feature-flag: agent_rooms\n---\n# Rooms\n'

async function fixture(): Promise<{ bakedDir: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'flag-overlay-'))
  roots.push(root)
  const bakedDir = join(root, 'baked')
  const configDir = join(root, 'config')
  await mkdir(join(bakedDir, 'kortix-cli'), { recursive: true })
  await writeFile(join(bakedDir, 'kortix-cli', 'SKILL.md'), '---\nname: kortix-cli\n---\n')
  await mkdir(join(bakedDir, 'kortix-rooms'), { recursive: true })
  await writeFile(join(bakedDir, 'kortix-rooms', 'SKILL.md'), ROOMS_SKILL)
  await mkdir(configDir, { recursive: true })
  return { bakedDir, configDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('feature flag parsing', () => {
  test('KORTIX_FEATURE_FLAGS is a comma list; nothing else adds a flag', () => {
    expect([...enabledFeatureFlags({ KORTIX_FEATURE_FLAGS: 'agent_rooms, reminders' })].sort()).toEqual(['agent_rooms', 'reminders'])
    expect(enabledFeatureFlags({ KORTIX_GENUI: '1' }).size).toBe(0)
    expect(enabledFeatureFlags({}).size).toBe(0)
  })

  test('a skill names its flag under metadata; no metadata means no flag', () => {
    expect(skillFeatureFlag(ROOMS_SKILL)).toBe('agent_rooms')
    expect(skillFeatureFlag('---\nname: kortix-cli\n---\nkortix-feature-flag: nope\n')).toBeNull()
  })
})

describe('a flagged managed skill follows its flag', () => {
  test('flag off: withheld from the overlay, the rest is written', async () => {
    const { bakedDir, configDir } = await fixture()
    expect(await withheldManagedSkills({}, bakedDir)).toEqual(['kortix-rooms'])
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: {} })
    expect(existsSync(join(configDir, 'skills', 'kortix-cli', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(configDir, 'skills', 'kortix-rooms'))).toBe(false)
  })

  test('flag on: written; turned off later: a reused dir loses it; on again: restored', async () => {
    const { bakedDir, configDir } = await fixture()
    const on = { KORTIX_FEATURE_FLAGS: 'agent_rooms' }
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: on })
    const skillsDir = join(configDir, 'skills')
    expect(existsSync(join(skillsDir, 'kortix-rooms', 'SKILL.md'))).toBe(true)
    await syncFlaggedManagedSkills(skillsDir, { bakedDir, env: {} })
    expect(existsSync(join(skillsDir, 'kortix-rooms'))).toBe(false)
    await syncFlaggedManagedSkills(skillsDir, { bakedDir, env: on })
    expect(existsSync(join(skillsDir, 'kortix-rooms', 'SKILL.md'))).toBe(true)
  })
})
