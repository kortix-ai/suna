import { describe, expect, test } from 'bun:test';
import { filterSkills, skillScope } from './skill-scope';

const skill = (name: string, description: string | null = null) => ({
  name,
  path: `.opencode/skill/${name}/SKILL.md`,
  description,
});

describe('skillScope', () => {
  test('kortix-* skills are platform runtime', () => {
    expect(skillScope('kortix-cli')).toBe('kortix');
    expect(skillScope('kortix-presentation')).toBe('kortix');
  });
  test('everything else belongs to the workspace', () => {
    expect(skillScope('podcast')).toBe('workspace');
    expect(skillScope('my-kortix-thing')).toBe('workspace');
  });
});

describe('filterSkills', () => {
  const all = [skill('kortix-cli'), skill('podcast', 'Make an episode'), skill('dataviz')];

  test('scope null returns everything', () => {
    expect(filterSkills(all, { scope: null, query: '' })).toHaveLength(3);
  });
  test('scope narrows to one family', () => {
    expect(filterSkills(all, { scope: 'kortix', query: '' }).map((s) => s.name)).toEqual([
      'kortix-cli',
    ]);
  });
  test('query matches name and description, case-insensitively', () => {
    expect(filterSkills(all, { scope: null, query: 'POD' }).map((s) => s.name)).toEqual(['podcast']);
    expect(filterSkills(all, { scope: null, query: 'episode' }).map((s) => s.name)).toEqual([
      'podcast',
    ]);
  });
  test('scope and query compose', () => {
    expect(filterSkills(all, { scope: 'workspace', query: 'kortix' })).toHaveLength(0);
  });
});
