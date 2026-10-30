import { describe, expect, test } from 'bun:test';
import {
  AGENT_FILE_PATTERN,
  safeAgentFile,
  safeRepoPath,
  safeToolFile,
  TOOL_FILE_PATTERN,
} from '../index';

describe('safeRepoPath', () => {
  test('keeps literal relative paths and drops a trailing slash', () => {
    expect(safeRepoPath('agents/support.md')).toBe('agents/support.md');
    expect(safeRepoPath('skills/pdf/')).toBe('skills/pdf');
    expect(safeRepoPath('.kortix/tools')).toBe('.kortix/tools');
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
    ['.kortix/agents/kortix.md', true],
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

describe('safeToolFile and TOOL_FILE_PATTERN agree', () => {
  const pattern = new RegExp(TOOL_FILE_PATTERN, 'u');
  const cases: Array<[string, boolean]> = [
    ['tools/lookup_order.ts', true],
    ['ping.js', true],
    ['integrations/crm/note.mjs', true],
    ['lib/tool.mts', true],
    ['tools/README.md', false],
    ['tools/.ts', false],
    ['tools/', false],
    ['/tools/a.ts', false],
    ['-tools/a.ts', false],
    ['../a.ts', false],
    ['tools/../a.ts', false],
    ['./a.ts', false],
    ['tools//a.ts', false],
    ['tools/*.ts', false],
  ];
  for (const [value, valid] of cases) {
    test(`${JSON.stringify(value)} → ${valid}`, () => {
      expect(safeToolFile(value) !== null).toBe(valid);
      expect(pattern.test(value)).toBe(valid);
    });
  }
});
