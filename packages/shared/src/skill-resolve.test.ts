import { describe, expect, test } from 'bun:test';
import { skillBySegment, skillFolderSlug } from './skill-resolve';

const skill = (name: string, path: string, description: string | null = 'Ship the release') => ({
  name,
  path,
  description,
});

describe('skillFolderSlug', () => {
  test('reads the folder that owns the SKILL.md, v2 and legacy alike', () => {
    expect(skillFolderSlug('skills/dogfood-skill/SKILL.md')).toBe('dogfood-skill');
    expect(skillFolderSlug('.opencode/skill/release-notes/SKILL.md')).toBe('release-notes');
  });

  test('a path with no skill folder segment answers null', () => {
    expect(skillFolderSlug('SKILL.md')).toBeNull();
    expect(skillFolderSlug('agents/x.md')).toBeNull();
  });
});

describe('skillBySegment', () => {
  const skills = [
    skill('dogfood-skill', 'skills/dogfood-skill/SKILL.md'),
    skill('Release Notes', '.opencode/skill/release-notes/SKILL.md', null),
  ];

  test('a segment resolves by name or by the folder that owns the SKILL.md', () => {
    expect(skillBySegment(skills, 'dogfood-skill')?.path).toBe('skills/dogfood-skill/SKILL.md');
    expect(skillBySegment(skills, 'release-notes')?.name).toBe('Release Notes');
  });

  test('the resolution is case-insensitive on the name', () => {
    expect(skillBySegment(skills, 'DOGFOOD-SKILL')?.name).toBe('dogfood-skill');
  });

  test('an unknown segment answers undefined', () => {
    expect(skillBySegment(skills, 'gone')).toBeUndefined();
  });
});
