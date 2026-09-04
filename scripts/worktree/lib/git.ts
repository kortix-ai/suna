import { dirname, join } from 'node:path';
import { sh } from './exec';

export function repoRoot(): string {
  const r = sh(['git', 'rev-parse', '--show-toplevel']);
  if (!r.ok) throw new Error('not inside a git repository');
  return r.stdout.trim();
}
export function defaultWorktreePath(root: string, name: string): string {
  return join(dirname(root), `suna-${name}`);
}
export function branchExists(root: string, branch: string): boolean {
  return sh(['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}
/** True when `origin/<branch>` exists locally (after a fetch) but no local branch does. */
export function remoteBranchExists(root: string, branch: string): boolean {
  return sh(['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).ok;
}
/**
 * The `git worktree add` argv for `branch`: check out the local branch when it
 * exists; otherwise create it tracking `origin/<branch>` when that ref exists;
 * otherwise create it from `from`. Pure — callers run it.
 */
export function worktreeAddArgs(root: string, wtPath: string, branch: string, from: string): { args: string[]; mode: 'local' | 'remote' | 'new' } {
  if (branchExists(root, branch)) return { args: ['git', '-C', root, 'worktree', 'add', wtPath, branch], mode: 'local' };
  if (remoteBranchExists(root, branch))
    return { args: ['git', '-C', root, 'worktree', 'add', '--track', '-b', branch, wtPath, `origin/${branch}`], mode: 'remote' };
  return { args: ['git', '-C', root, 'worktree', 'add', '-b', branch, wtPath, from], mode: 'new' };
}

/**
 * Remove the worktree at `path`, or throw.
 *
 * `git worktree remove` refuses a checkout that has uncommitted changes unless
 * it is forced. An unchecked call therefore fails silently and leaves both the
 * directory and its `git worktree list` registration in place — while the
 * caller goes on to drop the registry slot, orphaning the worktree beyond the
 * reach of `pnpm worktree`. Callers must let this throw rather than report a
 * removal that did not happen.
 */
export function removeWorktree(root: string, path: string, force: boolean): void {
  const r = sh(['git', '-C', root, 'worktree', 'remove', ...(force ? ['--force'] : []), path]);
  if (r.ok) return;
  const detail = (r.stderr || r.stdout).trim().split('\n')[0] || `exit code ${r.code}`;
  const remedy = force ? '' : ' — pass --force to discard the working tree';
  throw new Error(`git worktree remove failed: ${detail}${remedy}`);
}
