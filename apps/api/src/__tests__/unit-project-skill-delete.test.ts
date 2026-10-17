import { describe, expect, test } from 'bun:test';

import { skillFolderFilePaths, PROJECT_SKILL_SLUG_PATTERN } from '../projects/lib/project-resources';

describe('skillFolderFilePaths (KRTX-2543 delete)', () => {
  const files = [
    { path: 'skills/deploy/SKILL.md' },
    { path: 'skills/deploy/scripts/ship.sh' },
    { path: 'skills/deploy-alt/SKILL.md' },
    { path: 'skills/other/SKILL.md' },
    { path: 'agents/deploy.md' },
    { path: 'README.md' },
  ];

  test('selects every file under the skill folder and nothing else', () => {
    expect(skillFolderFilePaths(files, 'deploy')).toEqual([
      'skills/deploy/SKILL.md',
      'skills/deploy/scripts/ship.sh',
    ]);
  });

  test('a slug that prefixes another folder does not swallow it', () => {
    // `deploy` must not reach `deploy-alt`: the trailing slash in the prefix
    // is what keeps a deletion commit to its own folder.
    expect(skillFolderFilePaths(files, 'deploy')).not.toContain('skills/deploy-alt/SKILL.md');
    expect(skillFolderFilePaths(files, 'deploy-alt')).toEqual(['skills/deploy-alt/SKILL.md']);
  });

  test('a slug the repo does not carry selects nothing', () => {
    expect(skillFolderFilePaths(files, 'gone')).toEqual([]);
  });
});

describe('PROJECT_SKILL_SLUG_PATTERN (KRTX-2543 delete)', () => {
  test('accepts the slugs the create path derives', () => {
    expect(PROJECT_SKILL_SLUG_PATTERN.test('deploy')).toBe(true);
    expect(PROJECT_SKILL_SLUG_PATTERN.test('my-skill_2')).toBe(true);
  });

  test('rejects traversal, nesting and blank slugs', () => {
    expect(PROJECT_SKILL_SLUG_PATTERN.test('../secrets')).toBe(false);
    expect(PROJECT_SKILL_SLUG_PATTERN.test('a/b')).toBe(false);
    expect(PROJECT_SKILL_SLUG_PATTERN.test('')).toBe(false);
  });
});
