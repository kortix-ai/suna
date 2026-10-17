import { describe, expect, test } from 'bun:test';
import { stripAnsi } from '../style.ts';
import { renderSkillDetail, renderSkillRows, skillBySegment, slugFromSkillPath } from './project-skills.ts';

const skill = (name: string, path: string, description: string | null = 'Ship the release') => ({
  name,
  path,
  description,
});

describe('slugFromSkillPath', () => {
  test('reads the folder that owns the SKILL.md, v2 and legacy alike', () => {
    expect(slugFromSkillPath('skills/dogfood-skill/SKILL.md')).toBe('dogfood-skill');
    expect(slugFromSkillPath('.opencode/skill/release-notes/SKILL.md')).toBe('release-notes');
  });

  test('a path with no skill folder segment answers null', () => {
    expect(slugFromSkillPath('SKILL.md')).toBeNull();
    expect(slugFromSkillPath('agents/x.md')).toBeNull();
  });
});

describe('skillBySegment', () => {
  const skills = [
    skill('dogfood-skill', 'skills/dogfood-skill/SKILL.md'),
    skill('Release Notes', '.opencode/skill/release-notes/SKILL.md', null),
  ];

  test('a URL segment resolves by name or by folder slug', () => {
    expect(skillBySegment(skills, 'dogfood-skill')?.name).toBe('dogfood-skill');
    expect(skillBySegment(skills, 'release-notes')?.name).toBe('Release Notes');
  });

  test('an unknown segment answers undefined', () => {
    expect(skillBySegment(skills, 'nope')).toBeUndefined();
  });
});

describe('renderSkillRows', () => {
  test('lists every skill with its description, unstyled under NO_COLOR', () => {
    const out = stripAnsi(renderSkillRows([skill('dogfood-skill', 'skills/dogfood-skill/SKILL.md'), skill('release', 'skills/release/SKILL.md', null)]));
    expect(out).toContain('dogfood-skill');
    expect(out).toContain('Ship the release');
    expect(out).toContain('release');
  });

  test('an empty project says so instead of printing a bare header', () => {
    const out = stripAnsi(renderSkillRows([]));
    expect(out).toMatch(/no skills/i);
  });
});

describe('renderSkillDetail', () => {
  test('heads with the name and prints the SKILL.md body', () => {
    const out = stripAnsi(renderSkillDetail(skill('dogfood-skill', 'skills/dogfood-skill/SKILL.md'), '# Ship it\n\nCarefully.'));
    expect(out).toContain('dogfood-skill');
    expect(out).toContain('skills/dogfood-skill/SKILL.md');
    expect(out).toContain('# Ship it');
    expect(out).toContain('Carefully.');
  });
});
