import { describe, expect, test } from 'bun:test';
import { isExpectedFileRevisionRace } from './branches';
import { GitOperationError, isRemotePushPolicyRejection } from './mirror';

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

// Regression for Better Stack frontend pattern `5e505349…`: after a project's
// repo rejected the direct push to its default branch by repository rule, the
// API returned a 5xx and the dashboard paged it as an opaque `ApiError`. A
// remote-policy rejection is permanent and user-actionable — it must classify
// as a typed 4xx, distinct from a stale-tip race and from a transient mirror
// failure.
describe('remote push policy rejection classification', () => {
  const policyRejection = () =>
    gitFailure(
      ['push', 'origin', 'abc:refs/heads/main'],
      "To https://github.com/<org>/<repo>.git\n ! [remote rejected] abc -> main (push declined due to repository rule violations)\nerror: failed to push some refs to 'https://github.com/<org>/<repo>.git'",
    );

  test('classifies a repository-rule push rejection as a permanent policy rejection', () => {
    expect(isRemotePushPolicyRejection(policyRejection())).toBe(true);
  });

  test('does NOT mistake the policy rejection for a stale-tip revision race', () => {
    expect(isExpectedFileRevisionRace(policyRejection())).toBe(false);
  });

  test('classifies protected-branch and pre-receive-hook rejections', () => {
    expect(
      isRemotePushPolicyRejection(
        gitFailure(
          ['push', 'origin'],
          'remote: error: GH006: Protected branch update failed for refs/heads/main.',
        ),
      ),
    ).toBe(true);
    expect(
      isRemotePushPolicyRejection(
        gitFailure(
          ['push', 'origin'],
          '! [remote rejected] abc -> main (pre-receive hook declined)',
        ),
      ),
    ).toBe(true);
    expect(
      isRemotePushPolicyRejection(
        gitFailure(
          ['push', 'origin'],
          '! [remote rejected] abc -> main (protected branch hook declined)',
        ),
      ),
    ).toBe(true);
  });

  test('does not classify races, auth failures or transient failures as policy', () => {
    expect(
      isRemotePushPolicyRejection(
        gitFailure(['push', 'origin'], '! [rejected] main -> main (non-fast-forward)'),
      ),
    ).toBe(false);
    expect(
      isRemotePushPolicyRejection(
        gitFailure(['push', 'origin'], '! [remote rejected] abc -> main (failed to update ref)'),
      ),
    ).toBe(false);
    expect(
      isRemotePushPolicyRejection(gitFailure(['push', 'origin'], 'fatal: Authentication failed')),
    ).toBe(false);
    expect(
      isRemotePushPolicyRejection(
        gitFailure(['push', 'origin'], "fatal: couldn't connect to server"),
      ),
    ).toBe(false);
    expect(isRemotePushPolicyRejection(new Error('not a git operation error'))).toBe(false);
  });

  test('ignores the policy phrase on a non-push subcommand', () => {
    expect(
      isRemotePushPolicyRejection(
        gitFailure(['fetch', 'origin'], 'push declined due to repository rule violations'),
      ),
    ).toBe(false);
  });
});
