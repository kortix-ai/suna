import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// getBranchDiff / getDiffBetweenShas run REAL git against a real local mirror —
// only `refreshMirror` is re-bound (to the temp repo path) so no network is
// touched. This pins the contract the review page's file accordion depends on:
// the file list and the patch come from the same diff, and a patch git could
// not produce must never masquerade as "no changes".
const mirrorModule = await import('./mirror');
let repoPath = '';
mock.module('./mirror', () => ({
  ...mirrorModule,
  refreshMirror: async () => repoPath,
}));

const { getBranchDiff } = await import('./merge');

const runGit = promisify(execFile);

const project = {
  projectId: 'test-project',
  defaultBranch: 'base',
  repoUrl: 'https://github.com/kortix-ai/test.git',
  gitAuthToken: null,
  gitAuthHeaders: {},
} as import('./types').GitBackedProject;

/** A bare mirror with `base` and `head` branches; head carries `edits`. */
async function makeMirror(
  edits: (dir: string) => Promise<void>,
): Promise<{ root: string; mirror: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-merge-diff-test-'));
  const work = join(root, 'work');
  const mirror = join(root, 'mirror.git');
  const run = (args: string[], cwd = work) => runGit('git', args, { cwd });
  await run(['init', '-q', work], root);
  await run(['config', 'user.email', 't@example.test']);
  await run(['config', 'user.name', 't']);
  await writeFile(join(work, 'readme.md'), 'base\n');
  await run(['add', '-A']);
  await run(['commit', '-qm', 'base']);
  await run(['branch', 'base']);
  await run(['checkout', '-qb', 'head']);
  await mkdir(join(work, 'src'), { recursive: true });
  await edits(work);
  await run(['add', '-A']);
  await run(['commit', '-qm', 'head']);
  await run(['clone', '-q', '--bare', work, mirror]);
  return { root, mirror };
}

describe('getBranchDiff — the diff the review page renders', () => {
  test('a diff whose patch exceeds the git output cap reports patch_truncated and keeps the file list', async () => {
    const { root, mirror } = await makeMirror(async (dir) => {
      // ~14 MB of new content: `git diff --no-color` output blows the 10 MiB
      // exec cap that runGit sets, while --name-status stays a few bytes.
      const line = 'changed 00000000 abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmn\n';
      await writeFile(join(dir, 'src', 'big.txt'), line.repeat(240000));
    });
    repoPath = mirror;
    try {
      const diff = await getBranchDiff(project, 'base', 'head');
      expect(diff.files_changed).toBe(1);
      expect(diff.files.map((f) => f.path)).toEqual(['src/big.txt']);
      expect(diff.additions).toBeGreaterThan(0);
      expect(diff.patch).toBe('');
      expect(diff.patch_truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a normal diff is complete: the patch is present and not flagged truncated', async () => {
    const { root, mirror } = await makeMirror(async (dir) => {
      await writeFile(join(dir, 'src', 'app.ts'), 'export const x = 1;\n');
    });
    repoPath = mirror;
    try {
      const diff = await getBranchDiff(project, 'base', 'head');
      expect(diff.files.map((f) => f.path)).toEqual(['src/app.ts']);
      expect(diff.patch).toContain('diff --git a/src/app.ts b/src/app.ts');
      expect(diff.patch).toContain('+export const x = 1;');
      expect(diff.patch_truncated).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
