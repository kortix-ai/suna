import { access, constants, cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from './logger'

/**
 * Image-baked copy of the always-latest Kortix system skills — `kortix-cli`
 * (the front door) plus the managed `kortix-*` family. Produced by the snapshot
 * Dockerfile so every session boots with the current bodies with zero network
 * work. Each subdirectory is a skill folder (`<name>/SKILL.md`, references, …).
 */
const BAKED_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills'

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Always-inject the Kortix system skills into the session's OpenCode skills dir.
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
