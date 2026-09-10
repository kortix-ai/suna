import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitBackedProject } from '../git/types';
import {
  compilePiSkills,
  filterPiSkillsForPermission,
  resolveCompiledPiSkillsForSession,
} from './compile-pi-skills';

const roots: string[] = [];
const originalMirrorRoot = process.env.KORTIX_GIT_CACHE_DIR;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kortix Test',
      GIT_AUTHOR_EMAIL: 'test@kortix.test',
      GIT_COMMITTER_NAME: 'Kortix Test',
      GIT_COMMITTER_EMAIL: 'test@kortix.test',
    },
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalMirrorRoot === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalMirrorRoot;
});

describe('compilePiSkills', () => {
  test('discovers all deliberate project roots and gives the canonical Pi root precedence', () => {
    const files = {
      '.claude/skills/release/SKILL.md':
        '---\nname: release\ndescription: Claude release\n---\n\nUse Claude rules.\n',
      '.agents/skills/review/SKILL.md':
        '---\nname: review\ndescription: Review changes\n---\n\nReview carefully.\n',
      '.opencode/skills/search/SKILL.md':
        '---\nname: search\ndescription: Search sources\n---\n\nSearch first.\n',
      '.kortix/opencode/skills/legacy/SKILL.md':
        '---\nname: legacy\ndescription: Legacy rules\n---\n\nLegacy body.\n',
      '.kortix/pi/skills/release/SKILL.md':
        '---\nname: release\ndescription: Pi release\n---\n\nUse Pi rules.\n',
      '.kortix/pi/skills/release/scripts/changelog.ts': 'throw new Error("must run remotely")',
      '.kortix/pi/skills/release/references/policy.md': '# Policy',
    };

    expect(compilePiSkills({ configDir: '.kortix/pi', files })).toEqual([
      {
        name: 'legacy',
        description: 'Legacy rules',
        location: '.kortix/opencode/skills/legacy/SKILL.md',
        content: 'Legacy body.\n',
        files: [],
      },
      {
        name: 'release',
        description: 'Pi release',
        location: '.kortix/pi/skills/release/SKILL.md',
        content: 'Use Pi rules.\n',
        files: ['references/policy.md', 'scripts/changelog.ts'],
      },
      {
        name: 'review',
        description: 'Review changes',
        location: '.agents/skills/review/SKILL.md',
        content: 'Review carefully.\n',
        files: [],
      },
      {
        name: 'search',
        description: 'Search sources',
        location: '.opencode/skills/search/SKILL.md',
        content: 'Search first.\n',
        files: [],
      },
    ]);
  });

  test('filters denied skill bytes while retaining allow and ask skills', () => {
    const skills = [
      { name: 'public', location: 'public/SKILL.md', content: 'public', files: [] },
      { name: 'internal-docs', location: 'internal/SKILL.md', content: 'secret', files: [] },
      { name: 'experimental-ui', location: 'experimental/SKILL.md', content: 'ask', files: [] },
    ];

    expect(
      filterPiSkillsForPermission(skills, {
        skill: { '*': 'allow', 'internal-*': 'deny', 'experimental-*': 'ask' },
      }),
    ).toEqual([skills[0], skills[2]]);
    expect(filterPiSkillsForPermission(skills, 'deny')).toEqual([]);
  });
});

describe('resolveCompiledPiSkillsForSession', () => {
  test('reads skill bodies and support paths from the immutable source SHA', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-pi-skills-'));
    roots.push(root);
    const source = join(root, 'source');
    mkdirSync(join(source, '.kortix', 'pi', 'skills', 'release', 'scripts'), { recursive: true });
    git(['init', '-b', 'main'], source);
    writeFileSync(join(source, 'kortix.yaml'), 'kortix_version: 3\ndefault_agent: build\n');
    writeFileSync(
      join(source, '.kortix', 'pi', 'skills', 'release', 'SKILL.md'),
      '---\nname: release\ndescription: Original\n---\n\nOriginal instructions.\n',
    );
    writeFileSync(
      join(source, '.kortix', 'pi', 'skills', 'release', 'scripts', 'release.ts'),
      'console.log("original")\n',
    );
    git(['add', '-A'], source);
    git(['commit', '-m', 'original skill'], source);
    const originalSha = git(['rev-parse', 'HEAD'], source);

    writeFileSync(
      join(source, '.kortix', 'pi', 'skills', 'release', 'SKILL.md'),
      '---\nname: release\ndescription: Moved\n---\n\nMoved instructions.\n',
    );
    git(['add', '-A'], source);
    git(['commit', '-m', 'move branch'], source);

    const mirrors = mkdtempSync(join(tmpdir(), 'kortix-pi-skill-mirrors-'));
    roots.push(mirrors);
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;
    const project: GitBackedProject = {
      projectId: crypto.randomUUID(),
      repoUrl: `file://${source}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: 'test-token',
    };

    expect(await resolveCompiledPiSkillsForSession(project, originalSha)).toEqual([
      {
        name: 'release',
        description: 'Original',
        location: '.kortix/pi/skills/release/SKILL.md',
        content: 'Original instructions.\n',
        files: ['scripts/release.ts'],
      },
    ]);
  });
});
