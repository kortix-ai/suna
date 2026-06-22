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
