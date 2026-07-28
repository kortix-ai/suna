import { describe, expect, test } from 'bun:test';
import { mayResolveApproval, maySeeSessionApprovals } from './approval-authority';

const WRAPPER = 'wrapper-service-account';
const HUMAN = 'human-1';

describe('mayResolveApproval', () => {
  test('an AGENT can never approve — not even its own session', () => {
    // The whole point of require_approval is a human in the loop. An automated
    // caller approving itself makes the gate decorative.
    const result = mayResolveApproval({
      isManager: false,
      targetSessionOrigin: 'backend',
      targetSessionCreatedBy: WRAPPER,
      callerUserId: WRAPPER,
      callerSessionId: 'my-own-session',
    });
    expect(result).toEqual({ allowed: false, reason: 'session_bound_caller' });
  });

  test("an agent cannot approve ANOTHER end-user's gated call", () => {
    const result = mayResolveApproval({
      isManager: false,
      targetSessionOrigin: 'backend',
      targetSessionCreatedBy: WRAPPER,
      callerUserId: WRAPPER,
      callerSessionId: 'some-other-session',
    });
    expect(result.allowed).toBe(false);
  });

  test('created_by does NOT confer launcher status on a backend session', () => {
    // Every KaaB session shares one created_by, so this test would pass for
    // every end-user against every other's approval.
    const result = mayResolveApproval({
      isManager: false,
      targetSessionOrigin: 'backend',
      targetSessionCreatedBy: WRAPPER,
      callerUserId: WRAPPER,
      callerSessionId: null,
    });
    expect(result).toEqual({ allowed: false, reason: 'not_launcher_or_manager' });
  });

  test('an INTERACTIVE session keeps its launcher — created_by is one person there', () => {
    const result = mayResolveApproval({
      isManager: false,
      targetSessionOrigin: 'user',
      targetSessionCreatedBy: HUMAN,
      callerUserId: HUMAN,
      callerSessionId: null,
    });
    expect(result.allowed).toBe(true);
  });

  test('a different human still cannot resolve an interactive session', () => {
    expect(
      mayResolveApproval({
        isManager: false,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: 'someone-else',
        callerSessionId: null,
      }).allowed,
    ).toBe(false);
  });

  test('a project manager may resolve either way', () => {
    for (const origin of ['backend', 'user']) {
      expect(
        mayResolveApproval({
          isManager: true,
          targetSessionOrigin: origin,
          targetSessionCreatedBy: WRAPPER,
          callerUserId: 'manager',
          callerSessionId: null,
        }).allowed,
      ).toBe(true);
    }
  });

  test('a session-bound caller is refused EVEN IF its token carries manager rights', () => {
    // The critical ordering. An agent's token inherits the role of whoever
    // minted it — in KaaB the wrapper's own account, which is usually a project
    // owner. Checking isManager first would hand the agent exactly the
    // authority this refusal exists to withhold, and the fix would be
    // decorative.
    expect(
      mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: WRAPPER,
        callerSessionId: 's1',
      }),
    ).toEqual({ allowed: false, reason: 'session_bound_caller' });
  });
});

describe('maySeeSessionApprovals', () => {
  const base = {
    isManager: false,
    targetSessionId: 'session-b',
    targetSessionOrigin: 'backend',
    targetSessionCreatedBy: WRAPPER,
    callerUserId: WRAPPER,
  };

  test("an agent sees only its OWN session's approvals", () => {
    // This is the leak that feeds the resolve exploit: an execution_id is all
    // the resolve route needs, and the old filter exposed every sibling's.
    expect(maySeeSessionApprovals({ ...base, callerSessionId: 'session-b' })).toBe(true);
    expect(maySeeSessionApprovals({ ...base, callerSessionId: 'session-a' })).toBe(false);
  });

  test('created_by does not expose backend sessions to a non-manager human', () => {
    expect(maySeeSessionApprovals({ ...base, callerSessionId: null })).toBe(false);
  });

  test('a manager sees them', () => {
    expect(maySeeSessionApprovals({ ...base, isManager: true, callerSessionId: null })).toBe(true);
  });

  test('an interactive session still shows to its real launcher', () => {
    expect(
      maySeeSessionApprovals({
        ...base,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: HUMAN,
        callerSessionId: null,
      }),
    ).toBe(true);
  });
});

describe('a service-account bearer may still resolve — deliberately', () => {
  test('the wrapper backend can relay its end-user approval decision', () => {
    // In KaaB the end-user has no Kortix identity, so the ONLY path for their
    // decision to reach this endpoint is relayed by the wrapper's backend.
    // Refusing service accounts would make require_approval unusable for the
    // exact product it exists to serve.
    //
    // Safe because an agent can never hold an SA bearer: the sandbox gets a
    // session-bound PAT, the per-agent SA's secret is hashed and DISCARDED at
    // creation, and /v1/accounts/* is refused for project-scoped tokens.
    expect(
      mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: 'wrapper-service-account-id',
        callerSessionId: null,
      }).allowed,
    ).toBe(true);
  });

  test('a service account WITHOUT manager rights still cannot resolve', () => {
    // Allowing the operator is not the same as allowing every non-human caller.
    expect(
      mayResolveApproval({
        isManager: false,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: 'some-service-account',
        callerSessionId: null,
      }).allowed,
    ).toBe(false);
  });
});
