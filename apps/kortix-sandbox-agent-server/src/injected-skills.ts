import { constants, access, cp, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { AcpHarnessId } from './acp/harness-registry'
import { logger } from './logger'

/**
 * Image-baked copy of the always-latest Kortix system skills — `kortix-cli`
 * (the front door) plus the managed `kortix-*` family. Produced by the snapshot
 * Dockerfile so every session boots with the current bodies with zero network
 * work. Each subdirectory is a skill folder (`<name>/SKILL.md`, references, …).
 */
const BAKED_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills'

export interface ManagedSkillConfigDirsInput {
  workspace: string
  opencodeConfigDir: string
  harness: AcpHarnessId | null
  runtimeConfigDir?: string | null
  includeOpenCode?: boolean
}

/**
 * Return the native config directories that must receive managed Kortix skills.
 *
 * OpenCode reads `<config>/skills`. Claude Code reads `<CLAUDE_CONFIG_DIR>/skills`.
 * Pi reads `<PI_CODING_AGENT_DIR>/skills`. Codex reads repo-scoped skills from
 * `<workspace>/.agents/skills`, independently of `CODEX_HOME`.
 */
export function managedSkillConfigDirs(input: ManagedSkillConfigDirsInput): string[] {
  const dirs = input.includeOpenCode === false ? [] : [input.opencodeConfigDir]
  if (input.harness === 'codex') {
    dirs.push(join(input.workspace, '.agents'))
  } else if (
    (input.harness === 'claude' || input.harness === 'pi') &&
    input.runtimeConfigDir?.trim()
  ) {
    const configDir = input.runtimeConfigDir.trim()
    dirs.push(isAbsolute(configDir) ? configDir : resolve(input.workspace, configDir))
  }
  return [...new Set(dirs)]
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Inject the Kortix system skills into one harness-native config directory.
 *
 * `kortix-cli` (and the rest of the `kortix-*` family) is the one thing Kortix
 * guarantees to every agent: it must be present AND current no matter what the
 * project repo contains — even if the committed copy was edited or deleted, and
 * even for an old project cloned months ago. We overlay the image-baked bodies
 * into `<configDir>/skills/` at boot (force-overwrite), so a stale repo copy is
 * refreshed to the latest and a missing one is restored. This is what keeps
 * projects from ever going stale on Kortix internals.
 *
 * Defensive by design: never throws (a failure just leaves the repo's own copy
 * in place), and no-ops when the baked dir is absent (e.g. a pre-bake image) —
 * exactly like `ensureOpencodeConfigDeps`, which it's called right after.
 */
export async function ensureInjectedManagedSkills(
  configDir: string,
  opts: { bakedDir?: string } = {},
): Promise<void> {
  const bakedDir = opts.bakedDir ?? BAKED_MANAGED_SKILLS_DIR
  try {
    if (!(await pathExists(bakedDir))) return // nothing baked → leave repo copies as-is
    const skillsDir = join(configDir, 'skills')
    const entries = await readdir(bakedDir, { withFileTypes: true })
    let injected = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await cp(join(bakedDir, entry.name), join(skillsDir, entry.name), {
        recursive: true,
        force: true, // overwrite → the injected body always wins over the repo copy
      })
      injected += 1
    }
    if (injected > 0) {
      logger.info('[boot] injected managed kortix skills', { configDir, from: bakedDir, injected })
    }
  } catch (err) {
    // Non-fatal: the repo's own copy (if any) stays in place.
    logger.warn('[boot] managed-skill injection skipped', { configDir, err: String(err) })
  }
}
