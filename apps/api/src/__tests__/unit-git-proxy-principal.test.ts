/**
 * Unit tests for the git proxy's principal model — who is pushing.
 *
 * The whole ref-level control is gated on this classification, in both
 * directions:
 *  - misclassify an agent as human ⇒ the control silently does nothing;
 *  - misclassify a human as an agent ⇒ we deny a real person's `git push` to
 *    their own default branch, which is worse than the hole we are closing.
 *
 * The trap worth a named test is the human PROJECT-SCOPED PAT. Humans mint
 * those (`POST /v1/projects/:id/tokens`, named `cli · <project name>`), so
 * `projectId !== null` looks agent-ish and is NOT an agent signal.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyGitPrincipal,
  isAgentAccountToken,
  protectedRefsFor,
  type GitPrincipal,
} from '../git-proxy/principal';

describe('isAgentAccountToken — PAT shapes', () => {
  test('session PAT (sessionId set) ⇒ agent', () => {
    // mintExecutorToken always sets sessionId = sandboxId. This is the token
    // the in-sandbox `kortix` CLI and any `git push` the agent runs use.
    expect(isAgentAccountToken({ sessionId: 'sandbox-123' })).toBe(true);
  });

  test('PAT carrying only an agentGrant ⇒ agent', () => {
    // agentGrant and serviceAccountId are each independently fail-safe-to-null
    // at mint, so no single field may be the sole signal.
    expect(isAgentAccountToken({ sessionId: null, agentGrant: { kortixCli: 'all' } })).toBe(true);
  });

  test('PAT carrying only a serviceAccountId ⇒ agent', () => {
    expect(
      isAgentAccountToken({ sessionId: null, agentGrant: null, serviceAccountId: 'sa-1' }),
    ).toBe(true);
  });

  test('THE TRAP: a human project-scoped PAT is NOT an agent', () => {
    // `projectId` is set, but sessionId/agentGrant/serviceAccountId are all
    // null. Classifying on projectId would deny a developer's laptop push.
    expect(
      isAgentAccountToken({ sessionId: null, agentGrant: null, serviceAccountId: null }),
    ).toBe(false);
  });

  test('unscoped human laptop PAT ⇒ not an agent', () => {
    expect(isAgentAccountToken({})).toBe(false);
  });
});

describe('classifyGitPrincipal', () => {
  const cases: Array<{ name: string; principal: GitPrincipal; expected: 'agent' | 'human' }> = [
    {
      name: 'sandbox runtime token (the daemon push)',
      principal: { kind: 'sandbox', sandboxId: 's-1', accountId: 'a-1' },
      expected: 'agent',
    },
    {
      name: 'session PAT (the AGI, and every in-sandbox `kortix` command)',
      principal: { kind: 'session', accountId: 'a-1', sessionId: 's-1' },
      expected: 'agent',
    },
    {
      name: "human's PAT",
      principal: { kind: 'user', accountId: 'a-1', userId: 'u-1' },
      expected: 'human',
    },
    {
      // DELIBERATE RESIDUAL: an account API key carries no user identity, so it
      // is indistinguishable from legitimate CI that pushes the default branch.
      // Sandboxes are never issued one. Reclassifying is its own change.
      name: 'account API key (v1: not treated as an agent)',
      principal: { kind: 'api_key', accountId: 'a-1', keyId: 'k-1' },
      expected: 'human',
    },
  ];

  for (const { name, principal, expected } of cases) {
    test(`${name} ⇒ ${expected}`, () => {
      expect(classifyGitPrincipal(principal)).toBe(expected);
    });
  }

  test('an unknown token kind falls closed to agent rather than silently allowing', () => {
    // Unreachable through the type system (the switch is exhaustive); this pins
    // the runtime direction if a future token kind slips through untyped.
    expect(classifyGitPrincipal({ kind: 'something-new' } as unknown as GitPrincipal)).toBe('agent');
  });
});

describe('protectedRefsFor', () => {
  test('qualifies a branch name into a full ref', () => {
    expect(protectedRefsFor({ projectDefaultBranch: 'main' })).toEqual(['refs/heads/main']);
  });

  test('THE DRIFT: both default_branch columns are protected, not just one', () => {
    // PATCH /v1/projects/:id updates only `projects.default_branch` and leaves
    // the connection row stale. Checking one column leaves the other as a
    // bypass; the union over-denies, which is the correct direction to err.
    expect(
      protectedRefsFor({ projectDefaultBranch: 'main', connectionDefaultBranch: 'master' }),
    ).toEqual(['refs/heads/main', 'refs/heads/master']);
  });

  test('identical columns dedupe to one ref', () => {
    expect(
      protectedRefsFor({ projectDefaultBranch: 'main', connectionDefaultBranch: 'main' }),
    ).toEqual(['refs/heads/main']);
  });

  test('a missing connection row (BYO/legacy project) is not an error', () => {
    expect(
      protectedRefsFor({ projectDefaultBranch: 'trunk', connectionDefaultBranch: null }),
    ).toEqual(['refs/heads/trunk']);
  });

  test('blank/whitespace branch names contribute nothing', () => {
    expect(protectedRefsFor({ projectDefaultBranch: '  ', connectionDefaultBranch: '' })).toEqual(
      [],
    );
  });

  test('an already-qualified ref is not double-prefixed', () => {
    expect(protectedRefsFor({ projectDefaultBranch: 'refs/heads/main' })).toEqual([
      'refs/heads/main',
    ]);
  });
});
