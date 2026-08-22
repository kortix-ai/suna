import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchExists, remoteBranchExists, worktreeAddArgs } from '../lib';

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A clone with one local branch (`main`) and one remote-only branch (`origin/feature`). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-git-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main', seed);
  git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  git(seed, 'branch', 'feature');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main', 'feature');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-q', 'main');
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
    const { args, mode } = worktreeAddArgs(root, '/tmp/wt', 'main', 'HEAD');
    expect(mode).toBe('local');
    expect(args.slice(3)).toEqual(['worktree', 'add', '/tmp/wt', 'main']);
  });
  test('an unknown branch is created from --from', () => {
    const root = fixture();
    const { args, mode } = worktreeAddArgs(root, '/tmp/wt', 'brand-new', 'main');
    expect(mode).toBe('new');
    expect(args.slice(3)).toEqual(['worktree', 'add', '-b', 'brand-new', '/tmp/wt', 'main']);
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
