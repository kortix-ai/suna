/**
 * Image-baked copy of the always-latest Kortix system skills — `kortix-cli`
 * (the front door) plus the managed `kortix-*` family. Produced by the snapshot
 * Dockerfile so every session boots with the current bodies with zero network
 * work. Each subdirectory is a skill folder (`<name>/SKILL.md`, references, …).
 */
const BAKED_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills'

/**
 * Where the managed-skill overlay lives on this box. ONE resolver, because two
 * modules have to agree on it: the injector (`services/skills/managed-skills.ts`)
 * and the config release verification (`services/config-provider/boot-config.ts`).
 * When verification read "no directory passed" as "no managed skills", every
 * overlay directory counted as a file someone had ADDED to the copy,
 * verification failed on every call, and the copy was silently re-extracted
 * (#7403 preview, 2026-09-18).
 */
export function managedSkillsDir(): string {
  return (process.env.KORTIX_MANAGED_SKILLS_DIR ?? '').trim() || BAKED_MANAGED_SKILLS_DIR
}
