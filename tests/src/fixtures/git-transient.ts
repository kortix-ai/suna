import { transientRetryDelayMs } from '../core/client';
import { sleep } from '../core/poll';

/** Git over HTTP failed at the edge or the load balancer, not in a handler. */
const TRANSIENT_GIT_HTTP = /(?:HTTP|returned error:) ?(?:408|502|503|504|524)\b|remote: Internal Server Error/;

/** `git <args>` talks to the remote, and repeating it cannot change the outcome. */
export function isReplaySafeGit(args: string[]): boolean {
  // Skip the global options that precede the subcommand: `-C <dir>`, `-c <k=v>`.
  let i = 0;
  while (args[i] === '-C' || args[i] === '-c') i += 2;
  const sub = args[i];
  return ['clone', 'fetch', 'ls-remote'].includes(sub) || (sub === 'push' && !args.includes('--delete'));
}

/**
 * Run a git command and repeat it, three attempts at most, when the remote
 * answered 408, 502, 503, 504, 524 or "remote: Internal Server Error" (CFG-2, CFG-11, GH-17, REM-1 on deployed staging). A
 * push repeated after one that landed reports "up-to-date". Every other
 * failure, including 4xx and ref rejections, reaches the caller on the first
 * attempt.
 */
export async function withTransientGitRetry<T>(args: string[], attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (n >= 3 || !isReplaySafeGit(args) || !TRANSIENT_GIT_HTTP.test(text)) throw error;
      await sleep(transientRetryDelayMs(n));
    }
  }
}
