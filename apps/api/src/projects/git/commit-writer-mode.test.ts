import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFileToBranch } from './commit-writer';

test('editing an executable file preserves its tree mode and ordinary files stay non-executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kortix-file-mode-'));
  const previousCache = process.env.KORTIX_GIT_CACHE_DIR;
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  try {
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
    git('init', '--initial-branch=main', seed);
    git('-C', seed, 'config', 'user.name', 'Synthetic');
    git('-C', seed, 'config', 'user.email', 'synthetic');
    await writeFile(join(seed, 'run.sh'), '#!/bin/sh\necho before\n');
    await chmod(join(seed, 'run.sh'), 0o755);
    await writeFile(join(seed, 'README.md'), 'before\n');
    git('-C', seed, 'add', 'run.sh', 'README.md');
    git('-C', seed, 'commit', '-m', 'Seed files');
    git('init', '--bare', remote);
    git('-C', seed, 'push', remote, 'main');
    git('--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const project = {
      projectId: `file-mode-${crypto.randomUUID()}`, repoUrl: remote,
      defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: null,
    };
    for (const [path, mode] of [['run.sh', '100755'], ['README.md', '100644']]) {
      const revision = git('--git-dir', remote, 'rev-parse', `main:${path}`);
      const content = path === 'run.sh' ? '#!/bin/sh\necho after\n' : 'after\n';
      const result = await commitFileToBranch(project, {
        path, content, message: 'Edit file', expectedFileRevision: { path, sha: revision },
      });
      expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(result.commitSha);
      expect(git('--git-dir', remote, 'ls-tree', 'main', '--', path).split(' ')[0]).toBe(mode);
      expect(git('--git-dir', remote, 'show', `main:${path}`)).toBe(content.trim());
    }
    await commitFileToBranch(project, { path: 'new.txt', content: 'new', message: 'New file' });
    expect(git('--git-dir', remote, 'ls-tree', 'main', '--', 'new.txt').split(' ')[0]).toBe('100644');
  } finally {
    if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
    else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
    await rm(root, { recursive: true, force: true });
  }
});
