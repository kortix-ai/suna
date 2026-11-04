/**
 * The kortix-genui managed skill exists in every session. Generative UI has no flag (2026-10-24):
 * the shipped skill names no `kortix-feature-flag`, so pi never withholds it.
 * Env from the flag era (`KORTIX_GENUI=0`, a flag list without `genui`) changes nothing.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withheldManagedSkills } from '@/services/skills/managed-skills'

const SHIPPED = join(import.meta.dir, '../../../../packages/starter/templates/managed/skills')
const FLAG_ERA_OFF = { KORTIX_GENUI: '0', KORTIX_FEATURE_FLAGS: 'agent_rooms' }

describe('the kortix-genui managed skill is never withheld', () => {
  test.each([['no flag env', {}], ['flag-era off env', FLAG_ERA_OFF]] as const)('%s', async (_, env) => {
    expect(existsSync(join(SHIPPED, 'kortix-genui', 'SKILL.md'))).toBe(true)
    expect(await withheldManagedSkills(env, SHIPPED)).not.toContain('kortix-genui')
  })
})
