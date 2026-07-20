import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendGitExcludeEntries } from '../git-exclude.ts';

test('repository-local excludes are appended once without replacing existing content', () => {
  const repo = mkdtempSync(resolve(tmpdir(), 'kortix-git-exclude-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: repo });
  const excludePath = resolve(repo, '.git', 'info', 'exclude');
  writeFileSync(excludePath, '# user entry\n/custom\n');

  appendGitExcludeEntries(repo, ['/.kortix/link.json'], 'Kortix local project binding');
  appendGitExcludeEntries(repo, ['/.kortix/link.json'], 'Kortix local project binding');

  expect(readFileSync(excludePath, 'utf8')).toBe(
    '# user entry\n/custom\n# Kortix local project binding\n/.kortix/link.json\n',
  );
});
