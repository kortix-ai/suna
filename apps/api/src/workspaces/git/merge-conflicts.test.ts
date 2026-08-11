import { describe, expect, test } from 'bun:test';

import { MergeConflictError, parseMergeTreeConflictPaths } from './merge';

describe('merge conflict errors', () => {
  test('extracts every conflict path from merge-tree output', () => {
    const stdout = [
      '0123456789abcdef0123456789abcdef01234567',
      '.kortix/memory/plain-support-log.md',
      'README.md',
      '',
      'Auto-merging .kortix/memory/plain-support-log.md',
      'CONFLICT (content): Merge conflict in .kortix/memory/plain-support-log.md',
    ].join('\n');

    expect(parseMergeTreeConflictPaths(stdout)).toEqual(['.kortix/memory/plain-support-log.md', 'README.md']);
  });

  test('carries a stable API code and the conflicting paths', () => {
    const error = new MergeConflictError(['README.md']);

    expect(error.code).toBe('MERGE_CONFLICT');
    expect(error.conflicts).toEqual(['README.md']);
    expect(error.message).toContain('Solve them with an agent');
  });
});
