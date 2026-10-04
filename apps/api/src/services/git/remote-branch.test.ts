import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { remoteBranchExists } from './branches';

const run = promisify(execFile);

let root: string;
let seededRepo: string;
let emptyRepo: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-remote-branch-'));
  emptyRepo = join(root, 'empty.git');
  seededRepo = join(root, 'seeded.git');
  await run('git', ['init', '--bare', '--initial-branch=main', emptyRepo]);
  await run('git', ['init', '--bare', '--initial-branch=main', seededRepo]);

  const work = join(root, 'work');
  await run('git', ['init', '-b', 'main', work]);
  await writeFile(join(work, 'kortix.yaml'), 'kortix_version: 2\n', 'utf8');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Kortix',
    GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix',
    GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
  };
  await run('git', ['add', '-A'], { cwd: work, env });
  await run('git', ['commit', '-m', 'chore: project setup'], { cwd: work, env });
  await run('git', ['push', seededRepo, 'main:refs/heads/main'], { cwd: work, env });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('remoteBranchExists', () => {
  test('is true for a repo that carries the default branch', async () => {
    const exists = await remoteBranchExists(
      { projectId: 'p1', repoUrl: seededRepo, defaultBranch: 'main', manifestPath: 'kortix.yaml' },
      'main',
    );
    expect(exists).toBe(true);
  });

  test('is false for a freshly created repo with no refs at all', async () => {
    const exists = await remoteBranchExists(
      { projectId: 'p2', repoUrl: emptyRepo, defaultBranch: 'main', manifestPath: 'kortix.yaml' },
      'main',
    );
    expect(exists).toBe(false);
  });

  test('is false for a branch name that is absent but does not match a prefix', async () => {
    const exists = await remoteBranchExists(
      { projectId: 'p3', repoUrl: seededRepo, defaultBranch: 'main', manifestPath: 'kortix.yaml' },
      'mai',
    );
    expect(exists).toBe(false);
  });

  test('rejects an unsafe branch name instead of shelling it out', async () => {
    await expect(
      remoteBranchExists(
        {
          projectId: 'p4',
          repoUrl: seededRepo,
          defaultBranch: 'main',
          manifestPath: 'kortix.yaml',
        },
        '--upload-pack=touch /tmp/pwned',
      ),
    ).rejects.toThrow();
  });
});
