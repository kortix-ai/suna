import { afterAll, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitBackedProject } from './types';

const root = mkdtempSync(join(tmpdir(), 'kortix-landed-heads-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.name', 'Synthetic test');
git('config', 'user.email', 'test@example.test');
writeFileSync(join(root, 'file'), 'base');
git('add', '.');
git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
for (let i = 0; i < 200; i++) git('branch', `landed-${i}`);
git('checkout', '-qb', 'unmerged');
writeFileSync(join(root, 'file'), 'not landed');
git('commit', '-qam', 'unmerged');
git('checkout', '-q', '--detach', base);
writeFileSync(join(root, 'file'), 'base advanced');
git('commit', '-qam', 'advance');
const tip = git('rev-parse', 'HEAD');
git('branch', 'equal');
const mirror = await import('./mirror');
const capture = mirror.runGitCapture;
let queries = 0;
mock.module('./mirror', () => ({
  ...mirror,
  refreshMirror: async () => root,
  runGitCapture: (...args: Parameters<typeof mirror.runGitCapture>) => {
    queries++;
    return capture(...args);
  },
}));
const { headRefsLandedIn } = await import('./merge');
const project: GitBackedProject = {
  projectId: 'synthetic', defaultBranch: 'equal', manifestPath: 'kortix.yaml', repoUrl: root, gitAuthToken: null, gitAuthHeaders: {},
};
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('classifies 200 carried heads in one Git query, excluding unmerged, missing and invalid refs', async () => {
  queries = 0;
  const heads = Array.from({ length: 200 }, (_, i) => `landed-${i}`);
  const landed = await headRefsLandedIn(project, tip, [...heads, 'equal', 'unmerged', 'missing', '../invalid', 'landed-*']);
  expect([...landed]).toEqual([...heads.map((head): [string, string] => [head, base]), ['equal', tip]]);
  expect(queries).toBe(1);
});

test('does no Git work for an empty candidate list', async () => {
  queries = 0;
  expect(await headRefsLandedIn(project, tip, [])).toEqual(new Map());
  expect(queries).toBe(0);
});

test('does not treat a failed ancestry query as successful classification', async () => {
  await expect(headRefsLandedIn(project, 'a'.repeat(40), ['equal'])).rejects.toThrow();
});
