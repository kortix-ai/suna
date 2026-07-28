/**
 * The shape of the Skills screen, minus React.
 *
 * Skills and Commands are the same artifact with two homes in the repo: a
 * folder of `SKILL.md` files an agent loads when a task calls for them, and a
 * folder of one-shot slash prompts. They shipped as two rail entries, and the
 * Commands one rendered NOTHING — the Customize switch had no `commands` case,
 * so the entry opened a blank pane. Folding both onto one screen with one pill
 * row restores Commands rather than retiring it.
 *
 * Everything here is pure so the tab/search/copy contract can be tested without
 * a DOM.
 */

import { toArray } from '@/features/workspace/customize/shared/utils';

export type SkillKind = 'skill' | 'command';

/** One entry of `config.skills` / `config.commands`. */
export interface SkillEntity {
  name: string;
  path: string;
  description: string | null;
}

export interface SkillKindMeta {
  kind: SkillKind;
  /** Pill label on the filter row. */
  label: string;
  /** Lowercase singular used in inline copy. */
  noun: string;
  /** `?tab=` value that deep-links to this kind. */
  param: string;
  searchPlaceholder: string;
  /** The one primary action, top right. */
  newLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  /** Shown in the detail modal when the file is only frontmatter. */
  emptyBodyLabel: string;
  noResultsMessage: string;
}

export const SKILL_KINDS: Record<SkillKind, SkillKindMeta> = {
  skill: {
    kind: 'skill',
    label: 'Skills',
    noun: 'skill',
    param: 'skills',
    searchPlaceholder: 'Search skills',
    newLabel: 'New skill',
    emptyTitle: 'No skills yet',
    emptyDescription: 'Create a skill to give agents a reusable capability.',
    emptyBodyLabel: 'Skill body is empty. Add content below the frontmatter.',
    noResultsMessage: 'No skill matches that search.',
  },
  command: {
    kind: 'command',
    label: 'Commands',
    noun: 'command',
    param: 'commands',
    searchPlaceholder: 'Search commands',
    newLabel: 'New command',
    emptyTitle: 'No commands yet',
    emptyDescription: 'Create a command to run a saved prompt from any session.',
    emptyBodyLabel: 'Command body is empty. Add the prompt content below the frontmatter.',
    noResultsMessage: 'No command matches that search.',
  },
};

/** Pill order on the filter row. Skills first — it is the default tab. */
export const SKILL_KIND_ORDER: readonly SkillKind[] = ['skill', 'command'];

export const SKILLS_DOCS_HREF = 'https://opencode.ai/docs/skills/';

/**
 * `?tab=` → kind. Accepts the singular too, because the legacy Customize
 * section id was `commands` but hand-written links use either. Anything
 * unrecognised falls back to Skills, the default tab, rather than erroring.
 */
export function parseSkillKind(raw: string | null | undefined): SkillKind {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'commands' || value === 'command') return 'command';
  return 'skill';
}

/** The `?tab=` query string for a kind. Empty for the default tab. */
export function skillKindQuery(kind: SkillKind): string {
  return kind === 'skill' ? '' : `?tab=${SKILL_KINDS[kind].param}`;
}

/** Commands read as `/name`; that slash is how you invoke one. */
export function skillDisplayName(kind: SkillKind, entity: SkillEntity): string {
  return kind === 'command' ? `/${entity.name}` : entity.name;
}

/** Last path segment — `SKILL.md` for a skill, `<name>.md` for a command. */
export function skillFileName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function matchesSkillQuery(entity: SkillEntity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entity.name.toLowerCase().includes(q) ||
    (entity.description?.toLowerCase().includes(q) ?? false) ||
    entity.path.toLowerCase().includes(q)
  );
}

/**
 * Filter the list for the search box.
 *
 * Takes `unknown` on purpose: the API types `config.skills` as a required
 * array, but repo-less / capability-gated / config-build-failure states return
 * it undefined or as a non-array object, and calling `.filter` on that throws
 * into prod Sentry. `toArray` guards both.
 */
export function filterSkills(entities: unknown, query: string): SkillEntity[] {
  return toArray<SkillEntity>(entities).filter((entity) => matchesSkillQuery(entity, query));
}
