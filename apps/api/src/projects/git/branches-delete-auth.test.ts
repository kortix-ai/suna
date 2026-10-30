import { expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { repoCachePath } from './mirror';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('GC uses the resolved upstream rather than the stale project URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kortix-gc-auth-'));
  const remote = join(root, 'remote.git');
  git('init', '--bare', remote);
  const tree = git('--git-dir', remote, 'mktree');
  const commit = git('--git-dir', remote, '-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-m', 'seed');
  git('--git-dir', remote, 'update-ref', 'refs/heads/expired', commit);
  let resolutions = 0;
  mock.module('../lib/git', () => ({
    resolveProjectGitAccessById: async () => {
      resolutions++;
      return { repoUrl: remote, token: 'synthetic', headers: {} };
    },
  }));
  try {
    const { deleteRemoteSessionBranch } = await import('./branches');
    const project = { projectId: crypto.randomUUID(), repoUrl: join(root, 'stale.git'), defaultBranch: 'main', manifestPath: 'kortix.yaml' };
    expect(await deleteRemoteSessionBranch(project, 'expired')).toBe(true);
    expect(existsSync(repoCachePath(project))).toBe(false);
    expect(resolutions).toBe(1);
    expect(git('ls-remote', '--heads', remote, 'refs/heads/expired')).toBe('');
  } finally {
    mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});
