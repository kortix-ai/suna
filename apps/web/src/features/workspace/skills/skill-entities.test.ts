import { describe, expect, test } from 'bun:test';

import {
  SKILL_KINDS,
  SKILL_KIND_ORDER,
  type SkillEntity,
  filterSkills,
  matchesSkillQuery,
  parseSkillKind,
  skillDisplayName,
  skillFileName,
  skillKindQuery,
} from './skill-entities';

const skill = (over: Partial<SkillEntity> = {}): SkillEntity => ({
  name: 'content-creation',
  path: '.kortix/opencode/skills/content-creation/SKILL.md',
  description: 'Load when drafting or editing external marketing copy.',
  ...over,
});

describe('tab resolution', () => {
  test('?tab=commands opens Commands', () => {
    expect(parseSkillKind('commands')).toBe('command');
  });

  test('the singular works too — the legacy section id and hand-written links differ', () => {
    expect(parseSkillKind('command')).toBe('command');
    expect(parseSkillKind('  Commands ')).toBe('command');
  });

  test('a missing or unrecognised tab falls back to Skills rather than erroring', () => {
    expect(parseSkillKind(null)).toBe('skill');
    expect(parseSkillKind(undefined)).toBe('skill');
    expect(parseSkillKind('')).toBe('skill');
    expect(parseSkillKind('workflows')).toBe('skill');
  });

  test('the query string round-trips, and the default tab carries none', () => {
    expect(skillKindQuery('skill')).toBe('');
    expect(skillKindQuery('command')).toBe('?tab=commands');
    expect(parseSkillKind(new URLSearchParams(skillKindQuery('command')).get('tab'))).toBe(
      'command',
    );
  });

  test('Skills is the first pill', () => {
    expect(SKILL_KIND_ORDER).toEqual(['skill', 'command']);
  });
});

describe('naming', () => {
  test('a command reads as the slash you type to invoke it', () => {
    expect(skillDisplayName('command', skill({ name: 'ship' }))).toBe('/ship');
  });

  test('a skill keeps its bare name', () => {
    expect(skillDisplayName('skill', skill({ name: 'dataviz' }))).toBe('dataviz');
  });

  test('the Files pane shows the file, not the folder chain', () => {
    expect(skillFileName('.kortix/opencode/skills/dataviz/SKILL.md')).toBe('SKILL.md');
    expect(skillFileName('.kortix/opencode/commands/ship.md')).toBe('ship.md');
  });

  test('a path with no separators is its own file name', () => {
    expect(skillFileName('SKILL.md')).toBe('SKILL.md');
  });
});

describe('search', () => {
  test('an empty query matches everything', () => {
    expect(matchesSkillQuery(skill(), '   ')).toBe(true);
  });

  test('matches on name, description and path', () => {
    expect(matchesSkillQuery(skill(), 'CONTENT')).toBe(true);
    expect(matchesSkillQuery(skill(), 'marketing copy')).toBe(true);
    expect(matchesSkillQuery(skill(), 'opencode/skills')).toBe(true);
    expect(matchesSkillQuery(skill(), 'nothing-like-this')).toBe(false);
  });

  test('a null description does not throw', () => {
    expect(matchesSkillQuery(skill({ description: null }), 'content')).toBe(true);
    expect(matchesSkillQuery(skill({ description: null }), 'drafting')).toBe(false);
  });
});

describe('filterSkills guards the API shape', () => {
  test('filters the list', () => {
    const list = [skill(), skill({ name: 'dataviz', path: 'a/dataviz/SKILL.md' })];
    expect(filterSkills(list, 'dataviz').map((s) => s.name)).toEqual(['dataviz']);
  });

  test('undefined and null come back as an empty list, not a crash', () => {
    // config.skills is typed as a required array but arrives undefined for
    // repo-less / capability-gated / config-build-failure projects.
    expect(filterSkills(undefined, '')).toEqual([]);
    expect(filterSkills(null, '')).toEqual([]);
  });

  test('a non-array value comes back empty instead of throwing on .filter', () => {
    expect(filterSkills({} as unknown, '')).toEqual([]);
  });
});

describe('copy stays short enough for the shell', () => {
  test('every empty-state description is one line', () => {
    for (const meta of Object.values(SKILL_KINDS)) {
      expect(meta.emptyDescription.length).toBeLessThanOrEqual(90);
      expect(meta.emptyDescription).not.toContain('\n');
    }
  });

  test('each kind names its own primary action', () => {
    expect(SKILL_KINDS.skill.newLabel).toBe('New skill');
    expect(SKILL_KINDS.command.newLabel).toBe('New command');
  });
});
