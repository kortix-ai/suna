import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteRemoteSessionBranch } from './branches';
import { repoCachePath } from './mirror';

const roots: string[] = [];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kortix-branch-gc-'));
  roots.push(root);
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  git('init', '--initial-branch=main', seed);
  git('-C', seed, 'config', 'user.name', 'Synthetic Test');
  git('-C', seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'fixture'), 'synthetic');
  git('-C', seed, 'add', 'fixture');
  git('-C', seed, 'commit', '-m', 'seed');
  git('clone', '--bare', seed, remote);
  git('--git-dir', remote, 'branch', 'expired-session');
  return { projectId: crypto.randomUUID(), repoUrl: remote, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'synthetic' };
}

test('deletes only the requested remote branch without cloning repository history', async () => {
  const project = await fixture();
  expect(await deleteRemoteSessionBranch(project, 'expired-session')).toBe(true);
  expect(git('ls-remote', '--heads', project.repoUrl, 'refs/heads/expired-session')).toBe('');
  expect(git('ls-remote', '--heads', project.repoUrl, 'refs/heads/main')).toContain('refs/heads/main');
  expect(existsSync(repoCachePath(project))).toBe(false);
  expect(await deleteRemoteSessionBranch(project, 'expired-session')).toBe(false);
});

test('refuses default branches and invalid refs before touching the remote', async () => {
  const project = await fixture();
  await expect(deleteRemoteSessionBranch(project, 'main')).rejects.toThrow();
  await expect(deleteRemoteSessionBranch(project, '--all')).rejects.toThrow();
  expect(git('ls-remote', '--heads', project.repoUrl, 'refs/heads/main')).toContain('refs/heads/main');
});

test('remote failures propagate rather than marking the branch already absent', async () => {
  const project = await fixture();
  await rm(project.repoUrl, { recursive: true });
  await expect(deleteRemoteSessionBranch(project, 'expired-session')).rejects.toThrow();
});
