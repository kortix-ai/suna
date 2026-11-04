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
import { withheldManagedSkills } from '@/services/skills/managed-skills'

const roots: string[] = []

const CHANNEL_MEMORY_SKILL = '---\nname: kortix-channel-memory\ndescription: "Channel memory."\nmetadata:\n  kortix-feature-flag: chat\n---\n# Channel memory\n'

async function fixture(): Promise<{ bakedDir: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'flag-overlay-'))
  roots.push(root)
  const bakedDir = join(root, 'baked')
  const configDir = join(root, 'config')
  await mkdir(join(bakedDir, 'kortix-cli'), { recursive: true })
  await writeFile(join(bakedDir, 'kortix-cli', 'SKILL.md'), '---\nname: kortix-cli\n---\n')
  await mkdir(join(bakedDir, 'kortix-channel-memory'), { recursive: true })
  await writeFile(join(bakedDir, 'kortix-channel-memory', 'SKILL.md'), CHANNEL_MEMORY_SKILL)
  await mkdir(configDir, { recursive: true })
  return { bakedDir, configDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('feature flag parsing', () => {
  test('KORTIX_FEATURE_FLAGS is a comma list; nothing else adds a flag', () => {
    expect([...enabledFeatureFlags({ KORTIX_FEATURE_FLAGS: 'chat, reminders' })].sort()).toEqual(['chat', 'reminders'])
    expect(enabledFeatureFlags({ KORTIX_GENUI: '1' }).size).toBe(0)
    expect(enabledFeatureFlags({}).size).toBe(0)
  })

  test('a skill names its flag under metadata; no metadata means no flag', () => {
    expect(skillFeatureFlag(CHANNEL_MEMORY_SKILL)).toBe('chat')
    expect(skillFeatureFlag('---\nname: kortix-cli\n---\nkortix-feature-flag: nope\n')).toBeNull()
  })
})

describe('a flagged managed skill follows its flag', () => {
  test('flag off: the flagged skill is withheld, the rest is not', async () => {
    const { bakedDir } = await fixture()
    expect(await withheldManagedSkills({}, bakedDir)).toEqual(['kortix-channel-memory'])
  })
})
