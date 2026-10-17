/**
 * Skill detail routing — the pure half of `/customize/skills/[name]`
 * (`skill-detail-page.tsx` renders it).
 *
 * The URL segment is the slug the REST scan keys on (`skillSlugFromPath`,
 * `apps/api/src/projects/lib/project-resources.ts`): the folder that owns the
 * `SKILL.md`. A skill's frontmatter name may differ from its folder (the form
 * sets both to the slug; a hand-authored skill need not), so resolution tries
 * the scan name first and falls back to the folder slug — the same order the
 * CLI's `projects skills get` uses.
 */

import type { ProjectConfigSkill } from '@/features/session/composer/menus/slash-items';

/** The folder segment a scan path points at; `null` when the path is not one. */
export function skillFolderSlug(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  if (segments[segments.length - 1] !== 'SKILL.md') return null;
  return segments[segments.length - 2];
}

/** Resolve a URL segment to one scanned skill, by name or by folder slug. */
export function skillBySegment(
  skills: readonly ProjectConfigSkill[],
  segment: string,
): ProjectConfigSkill | undefined {
  const wanted = segment.toLowerCase();
  return (
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) => skillFolderSlug(skill.path)?.toLowerCase() === wanted)
  );
}
