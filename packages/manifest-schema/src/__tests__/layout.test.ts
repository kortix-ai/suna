import { describe, expect, test } from 'bun:test';
import {
  AGENT_FILE_PATTERN,
  agentFileCandidates,
  opencodeConfigDirCandidates,
  safeAgentFile,
  safeRepoPath,
  skillDirs,
  validateManifest,
} from '../index';

describe('safeRepoPath', () => {
  test('keeps literal relative paths and drops a trailing slash', () => {
    expect(safeRepoPath('agents/support.md')).toBe('agents/support.md');
    expect(safeRepoPath('harnesses/opencode/')).toBe('harnesses/opencode');
    expect(safeRepoPath('.kortix/opencode')).toBe('.kortix/opencode');
  });

  test('rejects absolute, option-like, traversal, empty-segment and pathspec-magic values', () => {
    for (const bad of ['/etc', '-x', '../x', 'a/../b', './a', 'a/./b', 'a//b', ':(top)*', 'a/*', '', '   ', 7, null]) {
      expect(safeRepoPath(bad)).toBeNull();
    }
  });

  test('runs in linear time on a long run of slashes', () => {
    const started = performance.now();
    expect(safeRepoPath(`a${'/'.repeat(100_000)}b`)).toBeNull();
    expect(safeRepoPath(`agents${'/'.repeat(100_000)}`)).toBe('agents');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('safeAgentFile and AGENT_FILE_PATTERN agree', () => {
  const pattern = new RegExp(AGENT_FILE_PATTERN, 'u');
  const cases: Array<[string, boolean]> = [
    ['agents/support.md', true],
    ['support.md', true],
    ['team/agents/on call.md', true],
    ['.kortix/opencode/agents/kortix.md', true],
    ['..md', true],
    ['agents/support.txt', false],
    ['agents/.md', false],
    ['.md', false],
    ['/agents/support.md', false],
    ['-agents/support.md', false],
    ['../support.md', false],
    ['agents/../support.md', false],
    ['./support.md', false],
    ['agents//support.md', false],
    ['agents/*.md', false],
  ];
  for (const [value, valid] of cases) {
    test(`${JSON.stringify(value)} → ${valid}`, () => {
      expect(safeAgentFile(value) !== null).toBe(valid);
      expect(pattern.test(value)).toBe(valid);
    });
  }
});

describe('agentFileCandidates', () => {
  test('an explicit file is the only candidate', () => {
    expect(agentFileCandidates({ agents: { support: { file: 'team/support.md' } } }, 'support')).toEqual([
      'team/support.md',
    ]);
  });

  test('an unsafe explicit file yields no candidate instead of a guess', () => {
    expect(agentFileCandidates({ agents: { support: { file: '../support.md' } } }, 'support')).toEqual([]);
  });

  test('without file: agents/<name>.md, then the legacy OpenCode dir', () => {
    expect(agentFileCandidates({ agents: { support: {} } }, 'support')).toEqual([
      'agents/support.md',
      '.kortix/opencode/agents/support.md',
    ]);
    expect(agentFileCandidates({ opencode: { config_dir: 'custom/oc' } }, 'support')).toEqual([
      'agents/support.md',
      'custom/oc/agents/support.md',
    ]);
  });
});

describe('opencodeConfigDirCandidates and skillDirs', () => {
  test('default: harnesses/opencode, then the legacy dir', () => {
    expect(opencodeConfigDirCandidates({})).toEqual(['harnesses/opencode', '.kortix/opencode']);
    expect(skillDirs({})).toEqual(['skills', '.kortix/opencode/skills']);
  });

  test('an explicit opencode.config_dir is the only OpenCode dir and the legacy skill root', () => {
    const manifest = { opencode: { config_dir: '.kortix/opencode' } };
    expect(opencodeConfigDirCandidates(manifest)).toEqual(['.kortix/opencode']);
    expect(skillDirs(manifest)).toEqual(['skills', '.kortix/opencode/skills']);
  });
});

describe('agents.<name>.file validation', () => {
  const manifest = (file: string) =>
    `kortix_version: 2\ndefault_agent: support\nagents:\n  support:\n    file: ${JSON.stringify(file)}\n`;

  test('accepts a repo-relative .md path', () => {
    const issues = validateManifest(manifest('agents/support.md'), 'yaml').issues.filter(
      (issue) => issue.severity === 'error',
    );
    expect(issues).toEqual([]);
  });

  for (const bad of ['../support.md', 'agents/support.txt', '/agents/support.md']) {
    test(`rejects ${bad}`, () => {
      const { issues } = validateManifest(manifest(bad), 'yaml');
      expect(issues.some((issue) => issue.path === 'agents.support.file' && issue.severity === 'error')).toBe(true);
    });
  }
});
