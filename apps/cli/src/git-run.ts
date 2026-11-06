import { spawnSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** Set when git could not be started at all. */
  error?: Error;
}

/** Run `git <args>` in `cwd` (the process directory when undefined) and wait for it. Never throws. */
export function runGit(
  cwd: string | undefined,
  args: string[],
  opts: {
    inheritStdio?: boolean;
    env?: Record<string, string>;
    input?: string;
    maxBuffer?: number;
  } = {},
): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    input: opts.input,
    encoding: 'utf8',
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
    stdio: opts.inheritStdio ? 'inherit' : undefined,
  });
  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}
