import { genuiEnabled } from '@/lib/config/genui'

/**
 * Set by the API (projects/lib/session-sandbox-env-build.ts) at provisioning:
 * the project's enabled feature flags, comma-separated. Boot-only: a flag
 * change reaches the next new box of a session.
 */
export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS'

/** The project's enabled flags. KORTIX_GENUI=1 counts for boxes provisioned before the list existed. */
export function enabledFeatureFlags(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Set<string> {
  const flags = new Set(
    (env[FEATURE_FLAGS_ENV_NAME] ?? '')
      .split(',')
      .map((flag) => flag.trim())
      .filter(Boolean),
  )
  if (genuiEnabled(env)) flags.add('genui')
  return flags
}

/** Managed skills older overlays ship without the frontmatter key. */
const LEGACY_SKILL_FLAGS: Record<string, string> = { 'kortix-genui': 'genui' }

/**
 * The flag a skill exists behind: `metadata.kortix-feature-flag` in its SKILL.md
 * frontmatter, else the legacy table. Null for an unflagged skill.
 */
export function skillFeatureFlag(skillMd: string, name?: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? ''
  const declared = /^\s+kortix-feature-flag:\s*["']?([a-z0-9_]+)["']?\s*$/m.exec(frontmatter)?.[1]
  return declared ?? (name ? (LEGACY_SKILL_FLAGS[name] ?? null) : null)
}
