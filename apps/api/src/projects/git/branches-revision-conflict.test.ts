import { describe, expect, test } from 'bun:test';
import { isExpectedFileRevisionRace } from './branches';
import { GitOperationError } from './mirror';

function gitFailure(gitArgs: string[], stderr: string) {
  return new GitOperationError({
    kind: 'failed',
    message: stderr,
    gitArgs,
    exitCode: 1,
    stderr,
  });
}

describe('expected file revision race classification', () => {
  test('accepts only stale-value update-ref failures', () => {
    expect(
      isExpectedFileRevisionRace(
        gitFailure(
          ['update-ref', 'refs/heads/main'],
          "cannot lock ref 'refs/heads/main': is at abc but expected def",
        ),
      ),
    ).toBe(true);
    expect(
      isExpectedFileRevisionRace(
        gitFailure(
          ['update-ref', 'refs/heads/main'],
          "cannot lock ref 'refs/heads/main': unable to resolve reference",
        ),
      ),
    ).toBe(false);
    expect(
      isExpectedFileRevisionRace(
        gitFailure(
          ['update-ref', 'refs/heads/main'],
          "cannot lock ref 'refs/heads/main': File exists",
        ),
      ),
    ).toBe(false);
  });

  test('accepts a non-fast-forward push rejection', () => {
    expect(
      isExpectedFileRevisionRace(
        gitFailure(
          ['push', 'origin'],
          '! [rejected] main -> main (non-fast-forward)\nUpdates were rejected because the remote contains work.',
        ),
      ),
    ).toBe(true);
    expect(
      isExpectedFileRevisionRace(
        gitFailure(['push', 'origin'], '! [remote rejected] abc -> main (failed to update ref)'),
      ),
    ).toBe(true);
  });

  test('rejects authentication and server-hook push failures', () => {
    expect(
      isExpectedFileRevisionRace(gitFailure(['push', 'origin'], 'fatal: Authentication failed')),
    ).toBe(false);
    expect(
      isExpectedFileRevisionRace(
        gitFailure(
          ['push', 'origin'],
          '! [remote rejected] main -> main (pre-receive hook declined)',
        ),
      ),
    ).toBe(false);
  });
});
