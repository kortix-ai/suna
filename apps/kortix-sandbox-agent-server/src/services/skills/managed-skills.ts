import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { managedSkillsDir } from '@/lib/config/managed-skills-dir'
import { enabledFeatureFlags, skillFeatureFlag } from '@/lib/config/feature-flags'

/**
 * The managed skills whose feature flag (`metadata.kortix-feature-flag`) is off in this box, read
 * from the baked overlay and from the `kortix-*` copies in `skillsDir`. A flag-off box must not
 * have them.
 */
export async function withheldManagedSkills(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  bakedDir: string = managedSkillsDir(),
  skillsDir?: string,
): Promise<string[]> {
  const enabled = enabledFeatureFlags(env)
  const dirsOf = async (dir: string, only?: RegExp): Promise<Map<string, string>> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    return new Map(
      entries.filter((e) => e.isDirectory() && (!only || only.test(e.name))).map((e) => [e.name, join(dir, e.name)]),
    )
  }
  const candidates = new Map([...(skillsDir ? await dirsOf(skillsDir, /^kortix-/) : []), ...(await dirsOf(bakedDir))])
  const withheld: string[] = []
  for (const [name, dir] of [...candidates].sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => '')
    const flag = skillFeatureFlag(body)
    if (flag && !enabled.has(flag)) withheld.push(name)
  }
  return withheld
}
