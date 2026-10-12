import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchExists, freshBase, remoteBranchExists, removeWorktree, worktreeAddArgs } from '../lib';

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A clone with one local branch (`dev`) and one remote-only branch (`origin/feature`). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-git-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'dev', seed);
  git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  git(seed, 'branch', 'feature');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'dev', 'feature');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-q', 'dev');
  return clone;
}

describe('worktreeAddArgs', () => {
  test('a branch that exists only on origin is checked out tracking origin/<branch>, not created from HEAD', () => {
    const root = fixture();
    expect(branchExists(root, 'feature')).toBe(false);
    expect(remoteBranchExists(root, 'feature')).toBe(true);
    const { args, mode } = worktreeAddArgs(root, '/tmp/wt', 'feature', 'HEAD');
    expect(mode).toBe('remote');
    expect(args.slice(3)).toEqual(['worktree', 'add', '--track', '-b', 'feature', '/tmp/wt', 'origin/feature']);
  });
  test('a local branch is checked out as-is', () => {
    const root = fixture();
    const { args, mode } = worktreeAddArgs(root, '/tmp/wt', 'dev', 'HEAD');
    expect(mode).toBe('local');
    expect(args.slice(3)).toEqual(['worktree', 'add', '/tmp/wt', 'dev']);
  });
  test('an unknown branch is created from --from, with no upstream', () => {
    const root = fixture();
    const { args, mode } = worktreeAddArgs(root, '/tmp/wt', 'brand-new', 'dev');
    expect(mode).toBe('new');
    expect(args.slice(3)).toEqual(['worktree', 'add', '--no-track', '-b', 'brand-new', '/tmp/wt', 'dev']);
  });
  test('the remote argv really checks out the remote tip', () => {
    const root = fixture();
    const wt = join(root, '..', 'wt-feature');
    const { args } = worktreeAddArgs(root, wt, 'feature', 'HEAD');
    const r = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'origin/feature'));
    expect(git(wt, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature');
  });
});

describe('removeWorktree', () => {
  /** `fixture()` clone plus a worktree at `<clone>/../wt-<n>` checked out on `feature`. */
  function withWorktree() {
    const root = fixture();
    const path = join(root, '..', 'wt-removal');
    git(root, 'worktree', 'add', '-q', path, 'origin/feature');
    return { root, path };
  }

  test('a clean worktree is removed', () => {
    const { root, path } = withWorktree();
    removeWorktree(root, path, false);
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'worktree', 'list')).not.toContain(path);
  });

  test('a dirty worktree throws instead of reporting a removal that did not happen', () => {
    const { root, path } = withWorktree();
    writeFileSync(join(path, 'tracked.txt'), 'edit');
    git(path, 'add', 'tracked.txt');

    expect(() => removeWorktree(root, path, false)).toThrow(/git worktree remove failed/);

    // The whole point: the caller must not go on to drop the registry slot for a
    // directory that is still on disk and still registered with git.
    expect(existsSync(path)).toBe(true);
    expect(git(root, 'worktree', 'list')).toContain(path);
  });

  test('the thrown message names the remedy', () => {
    const { root, path } = withWorktree();
    writeFileSync(join(path, 'tracked.txt'), 'edit');
    git(path, 'add', 'tracked.txt');
    expect(() => removeWorktree(root, path, false)).toThrow(/pass --force/);
  });

  test('--force removes the same dirty worktree', () => {
    const { root, path } = withWorktree();
    writeFileSync(join(path, 'tracked.txt'), 'edit');
    git(path, 'add', 'tracked.txt');

    removeWorktree(root, path, true);
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'worktree', 'list')).not.toContain(path);
  });
})

/** The fixture, after someone else pushed a commit to origin/dev. Local `dev` is now stale. */
function staleMainFixture() {
  const clone = fixture();
  const other = join(clone, '..', 'other');
  git(join(clone, '..'), 'clone', '-q', join(clone, '..', 'origin.git'), other);
  git(other, 'checkout', '-q', 'dev');
  git(other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'newer');
  git(other, 'push', '-q', 'origin', 'dev');
  return { clone, other };
}

describe('freshBase', () => {
  test('dev resolves to the fetched origin/dev, never the stale local dev', () => {
    // A worktree cut from a primary checkout 455 commits behind carried a
    // tree #7843 had deleted. The new branch must start at origin's tip.
    const { clone, other } = staleMainFixture();
    expect(freshBase(clone, 'dev')).toBe('origin/dev');
    expect(git(clone, 'rev-parse', 'origin/dev')).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(git(clone, 'rev-parse', 'dev')).not.toBe(git(other, 'rev-parse', 'HEAD'));
  });
  test('an explicit base is kept as given', () => {
    const { clone } = staleMainFixture();
    expect(freshBase(clone, 'feature-x')).toBe('feature-x');
    expect(freshBase(clone, 'HEAD')).toBe('HEAD');
  });
  test('a new worktree from dev starts at origin/dev and pushes to its own name', () => {
    const { clone, other } = staleMainFixture();
    const wt = join(clone, '..', 'wt-new');
    const { args } = worktreeAddArgs(clone, wt, 'brand-new', freshBase(clone, 'dev'));
    expect(Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'));
    // No upstream: a bare `git push` must never target dev.
    const upstream = Bun.spawnSync(['git', '-C', wt, 'rev-parse', '--abbrev-ref', '@{upstream}'], { stdout: 'pipe', stderr: 'pipe' });
    expect(upstream.exitCode).not.toBe(0);
  });
});
