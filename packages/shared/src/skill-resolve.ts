/**
 * Project-skill identity — the one resolver behind every surface that addresses
 * a project skill by a segment: the web detail URL (`/customize/skills/[name]`)
 * and the CLI's `projects skills get <name|slug>`. The URL segment is the slug
 * the REST scan keys on (`skillSlugFromPath`,
 * `apps/api/src/projects/lib/project-resources.ts`): the folder that owns the
 * `SKILL.md`. A skill's frontmatter name may differ from its folder (the form
 * sets both to the slug; a hand-authored skill need not), so resolution tries
 * the scan name first and falls back to the folder slug.
 */

/** One entry of the project detail's `config.skills` scan (`ProjectConfigSummary.skills`). */
export interface ProjectSkillSummary {
  name: string;
  /** Repository-relative path of the skill's `SKILL.md`. */
  path: string;
  description?: string | null;
}

/**
 * The skill-directory segment of a scan path — the segment right before the
 * trailing `SKILL.md`. The v2 layout scans as `skills/<slug>/SKILL.md`; the
 * legacy OpenCode layout as `.opencode/skill/<slug>/SKILL.md`. A path that
 * does not name a SKILL.md (or has no folder around it) has no slug.
 */
export function skillFolderSlug(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  if (segments[segments.length - 1] !== 'SKILL.md') return null;
  return segments[segments.length - 2];
}

/**
 * Resolve a segment to one scanned skill, by name or by folder slug.
 * Case-insensitive on both, because a skill's frontmatter name may carry
 * capitals its folder never did.
 */
export function skillBySegment(
  skills: readonly ProjectSkillSummary[],
  segment: string,
): ProjectSkillSummary | undefined {
  const wanted = segment.toLowerCase();
  return (
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) => skillFolderSlug(skill.path)?.toLowerCase() === wanted)
  );
}
