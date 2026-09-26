/**
 * The project repository layout, as the daemon reads it. The daemon imports no
 * `@kortix/*` package, so this is its copy of the constants in
 * packages/manifest-schema/src/layout.ts — keep the two equal.
 *
 * Harness-neutral content sits at the repository root (`agents/`, `skills/`,
 * `memory/`); files one harness reads sit under `harnesses/<harness>/`.
 * Projects created before 2026-09 keep everything under `.kortix/opencode`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const SKILLS_DIR = 'skills'
/** Default OpenCode config dir when the manifest names none. */
export const OPENCODE_CONFIG_DIR = 'harnesses/opencode'
/** The pre-2026-09 OpenCode config dir, which also held agents/ and skills/. */
export const LEGACY_OPENCODE_CONFIG_DIR = '.kortix/opencode'

/** OpenCode config dirs to try, in order: the manifest's own, else the current then the legacy default. */
export function opencodeConfigDirCandidates(manifestConfigDir: string | null): string[] {
  return manifestConfigDir ? [manifestConfigDir] : [OPENCODE_CONFIG_DIR, LEGACY_OPENCODE_CONFIG_DIR]
}

/** Project skill roots under `projectRoot`, most specific first. */
export function projectSkillDirs(projectRoot: string): string[] {
  return [join(projectRoot, SKILLS_DIR), join(projectRoot, LEGACY_OPENCODE_CONFIG_DIR, SKILLS_DIR)]
}

/**
 * The dir whose `skills/` receives the managed-skill overlay for config dir `dir`.
 *
 * The overlay lands where the project keeps its skills, so a managed skill the
 * project also tracks is overwritten in place: OpenCode resolves two skills of
 * one name in whichever order its parser finishes, so a second copy anywhere
 * it scans is a coin flip. A release and the image default take it themselves.
 * In the working tree it goes to the config dir, unless the config dir keeps no
 * `skills/` and the project root does (the root layout: `harnesses/opencode`
 * beside `skills/`). Then the root's `skills/` takes it; OpenCode reads that
 * through `skills.paths` (`projectSkillsDir`, harness/open-code/lifecycle.ts).
 */
export function managedOverlayRoot(dir: string, projectRoot?: string): string {
  if (!projectRoot || !dir.startsWith(`${projectRoot}/`)) return dir
  const rootKeepsSkills = !existsSync(join(dir, SKILLS_DIR)) && existsSync(join(projectRoot, SKILLS_DIR))
  return rootKeepsSkills ? projectRoot : dir
}
