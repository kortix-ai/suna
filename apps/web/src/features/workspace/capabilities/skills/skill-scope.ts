import type { ProjectConfigSummary } from '@kortix/sdk';

export type SkillScope = 'project' | 'kortix';
type Skill = ProjectConfigSummary['skills'][number];

/**
 * The `kortix-*` family is platform runtime, force-injected into every session
 * at boot. It reads the same in every project and is not meaningfully editable
 * here, so it filters separately from the project's own skills.
 */
export function skillScope(name: string): SkillScope {
  return name.startsWith('kortix-') ? 'kortix' : 'project';
}

export function filterSkills(
  skills: readonly Skill[],
  opts: { scope: SkillScope | null; query: string },
): Skill[] {
  const q = opts.query.trim().toLowerCase();
  return skills.filter((s) => {
    if (opts.scope && skillScope(s.name) !== opts.scope) return false;
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)
    );
  });
}

/**
 * Which "nothing to show" copy applies, given a catalog's total item count
 * and the count left after the current filter/search. Shared by every
 * capability catalog (skills, commands, ...) — the logic has no skill-specific
 * shape, only counts in and a three-way outcome out, so one implementation
 * here is the only way the skills and commands pages can't drift apart on it.
 *
 * `null` means there is content to render — the caller shouldn't reach for
 * either empty variant. `'empty'` is the catalog genuinely has zero items
 * (the "Create a ..." invitation is honest here). `'no-match'` is items exist
 * but the current filter/search hid all of them — telling the user "No ...
 * yet" in that case is false and points at the wrong action (they need to
 * clear the filter, not create anything).
 */
export function catalogEmptyKind(
  totalCount: number,
  filteredCount: number,
): 'empty' | 'no-match' | null {
  if (filteredCount > 0) return null;
  return totalCount === 0 ? 'empty' : 'no-match';
}
