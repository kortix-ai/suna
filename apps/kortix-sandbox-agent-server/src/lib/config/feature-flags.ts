/**
 * Set by the API (projects/lib/session-sandbox-env-build.ts) at provisioning:
 * the project's enabled feature flags, comma-separated. Boot-only: a flag
 * change reaches the next new box of a session.
 */
export const FEATURE_FLAGS_ENV_NAME = 'KORTIX_FEATURE_FLAGS'

/** The project's enabled flags. */
export function enabledFeatureFlags(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Set<string> {
  return new Set(
    (env[FEATURE_FLAGS_ENV_NAME] ?? '')
      .split(',')
      .map((flag) => flag.trim())
      .filter(Boolean),
  )
}

/**
 * The flag a skill exists behind: `metadata.kortix-feature-flag` in its SKILL.md
 * frontmatter. Null for an unflagged skill.
 */
export function skillFeatureFlag(skillMd: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? ''
  return /^\s+kortix-feature-flag:\s*["']?([a-z0-9_]+)["']?\s*$/m.exec(frontmatter)?.[1] ?? null
}
