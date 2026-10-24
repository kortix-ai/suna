/**
 * The kortix-genui managed skill exists in every session. Generative UI has no flag (2026-10-24):
 * the overlay always writes the skill, and a reused config dir gets it back from the baked copy.
 * Env from the flag era (`KORTIX_GENUI=0`, a flag list without `genui`) changes nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureInjectedManagedSkills, syncFlaggedManagedSkills } from '@/services/skills/managed-skills'

const roots: string[] = []
const FLAG_ERA_OFF = { KORTIX_GENUI: '0', KORTIX_FEATURE_FLAGS: 'agent_rooms' }

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

describe('the kortix-genui managed skill is always written', () => {
  test.each([['no flag env', {}], ['flag-era off env', FLAG_ERA_OFF]] as const)('%s: the overlay writes kortix-genui with the rest', async (_, env) => {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env })
    expect(existsSync(join(configDir, 'skills', 'kortix-cli', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(configDir, 'skills', 'kortix-genui', 'SKILL.md'))).toBe(true)
  })

  test('a reused config dir keeps the skill on every spawn', async () => {
    const { bakedDir, configDir } = await fixture()
    await ensureInjectedManagedSkills(configDir, { bakedDir, env: {} })
    const skillsDir = join(configDir, 'skills')
    await syncFlaggedManagedSkills(skillsDir, { env: FLAG_ERA_OFF, bakedDir })
    expect(existsSync(join(skillsDir, 'kortix-genui', 'SKILL.md'))).toBe(true)
  })
})
