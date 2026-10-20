import { isUnder } from './procs';

/**
 * `sweep`: delete build output in idle checkouts. Build output, not worktrees,
 * is what fills this disk: Next/Turbopack `.next` and Rust `target` dirs run
 * 2–35 GB each, while a removed worktree frees ~0.2 GB (pnpm clones files).
 */
export const ARTIFACT_DIRS = ['.next', '.turbo', 'dist', 'target', 'test-results', 'playwright-report'];

/**
 * A checkout is busy when any process runs inside it or names it on its
 * command line. The path must end at a separator, so `…/suna` does not match
 * `…/suna-rooms`.
 */
export function sweepBusy(dir: string, cwds: string[], commands: string[]): boolean {
  const d = dir.replace(/\/+$/, '');
  const named = new RegExp(`${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/\\s'"]|$)`);
  return cwds.some((c) => isUnder(c, d)) || commands.some((c) => named.test(c));
}
