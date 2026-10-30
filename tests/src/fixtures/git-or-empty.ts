import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';

export function gitOrEmpty(args: string[], opts: Omit<ExecFileSyncOptionsWithStringEncoding, 'encoding'> = {}): string[] {
  try {
    return execFileSync('git', args, { cwd: new URL('../../..', import.meta.url), ...opts, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (error) {
    // git grep uses exit 1 for no matches, not an operational failure.
    if (error instanceof Error && 'status' in error && error.status === 1) return [];
    throw error;
  }
}
