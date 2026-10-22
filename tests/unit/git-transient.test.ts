import { describe, expect, it } from 'vitest';
import { isReplaySafeGit, withTransientGitRetry } from '../src/fixtures/git-transient';

const edge = (code: number) => new Error(`Command failed: git push\nerror: RPC failed; HTTP ${code} curl 22 The requested URL returned error: ${code}`);

describe('withTransientGitRetry', () => {
  it('repeats a push the edge answered 502, then returns the result', async () => {
    let calls = 0;
    const result = await withTransientGitRetry(['push', 'origin', 'HEAD:refs/heads/x'], async () => {
      if (++calls < 2) throw edge(502);
      return 'ok';
    });
    expect([result, calls]).toEqual(['ok', 2]);
  });

  it('gives up after three attempts', async () => {
    let calls = 0;
    await expect(
      withTransientGitRetry(['clone', 'u', '.'], async () => {
        calls++;
        throw edge(524);
      }),
    ).rejects.toThrow('524');
    expect(calls).toBe(3);
  });

  it('never repeats a 4xx or a ref rejection', async () => {
    for (const message of ['HTTP 403 curl 22 The requested URL returned error: 403', '[remote rejected] x -> y (denied)']) {
      let calls = 0;
      await expect(
        withTransientGitRetry(['push', 'origin', 'x'], async () => {
          calls++;
          throw new Error(message);
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it('sees the subcommand behind -C and -c, and repeats a GitHub 500', async () => {
    expect(isReplaySafeGit(['-C', '/tmp/x', 'push', 'origin', 'HEAD:refs/heads/main'])).toBe(true);
    expect(isReplaySafeGit(['-c', 'a=b', '-C', '/tmp/x', 'commit', '-m', 'x'])).toBe(false);
    let calls = 0;
    await withTransientGitRetry(['-C', '/tmp/x', 'push', 'origin', 'x'], async () => {
      if (++calls < 2) throw new Error('git push failed (1): remote: Internal Server Error\nremote: Request ID E02E');
    });
    expect(calls).toBe(2);
  });

  it('never repeats a ref delete or a local command', async () => {
    expect(isReplaySafeGit(['push', 'origin', '--delete', 'x'])).toBe(false);
    expect(isReplaySafeGit(['commit', '-m', 'x'])).toBe(false);
    expect(isReplaySafeGit(['ls-remote', 'origin'])).toBe(true);
  });
});
