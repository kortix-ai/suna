import { describe, expect, test } from 'bun:test';
import { skillBySegment } from './skill-resolve';

const skill = (name: string, path: string, description: string | null = 'Ship the release') => ({
  name,
  path,
  description,
});

describe('skillBySegment (KRTX-2543)', () => {
  const skills = [
    skill('dogfood-skill', 'skills/dogfood-skill/SKILL.md'),
    skill('Release Notes', '.opencode/skill/release-notes/SKILL.md', null),
  ];

  test('a URL segment resolves by name or by the folder that owns the SKILL.md', () => {
    expect(skillBySegment(skills, 'dogfood-skill')?.path).toBe('skills/dogfood-skill/SKILL.md');
    expect(skillBySegment(skills, 'release-notes')?.name).toBe('Release Notes');
  });

  test('the resolution is case-insensitive on the name', () => {
    expect(skillBySegment(skills, 'DOGFOOD-SKILL')?.name).toBe('dogfood-skill');
  });

  test('an unknown segment answers undefined so the page can say not-found', () => {
    expect(skillBySegment(skills, 'gone')).toBeUndefined();
  });
});
