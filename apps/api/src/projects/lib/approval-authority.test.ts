import { describe, expect, test } from 'bun:test';
import { approvalResolvers, mayResolveApproval, maySeeSessionApprovals } from './approval-authority';

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
      callerAuthType: 'supabase',
      callerCredentialKind: 'jwt',
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
      callerAuthType: 'supabase',
      callerCredentialKind: 'jwt',
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
      callerAuthType: 'supabase',
      callerCredentialKind: 'jwt',
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
      callerAuthType: 'supabase',
      callerCredentialKind: 'jwt',
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
        callerAuthType: 'supabase',
        callerCredentialKind: 'jwt',
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
          callerAuthType: 'supabase',
          callerCredentialKind: 'jwt',
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
        callerAuthType: 'supabase',
        callerCredentialKind: 'jwt',
        callerSessionId: 's1',
      }),
    ).toEqual({ allowed: false, reason: 'session_bound_caller' });
  });

  describe('the person behind the CLI (a personal PAT is the human)', () => {
    // A personal PAT is the same person their browser session is: the token row
    // carries a real user, holds no session binding and no service account. The
    // same manager-or-launcher rule that governs the dashboard therefore governs
    // `kortix sessions approvals … approve`. Session-bound, service-account,
    // sandbox and OAuth credentials stay refused below.
    test('a manager resolving with their own CLI PAT is allowed', () => {
      const result = mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: HUMAN,
        callerAuthType: 'pat',
        callerCredentialKind: 'pat',
        callerSessionId: null,
      });
      expect(result).toEqual({ allowed: true });
    });

    test('the launcher resolving their own interactive session with a CLI PAT is allowed', () => {
      const result = mayResolveApproval({
        isManager: false,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: HUMAN,
        callerAuthType: 'pat',
        callerCredentialKind: 'pat',
        callerSessionId: null,
      });
      expect(result).toEqual({ allowed: true });
    });

    test('a CLI PAT still needs the human rule — not manager, not launcher, refused', () => {
      const result = mayResolveApproval({
        isManager: false,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: 'someone-else',
        callerAuthType: 'pat',
        callerCredentialKind: 'pat',
        callerSessionId: null,
      });
      expect(result).toEqual({ allowed: false, reason: 'not_launcher_or_manager' });
    });

    test('an agent-session connector PAT (a service account behind it) is refused EVEN for a manager', () => {
      // kind 'agent_session' with NO session binding: the token row names a
      // service account, so it is an agent credential wearing a PAT coat. It
      // must never pass the human check, whatever role it inherits.
      const result = mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: HUMAN,
        callerAuthType: 'pat',
        callerCredentialKind: 'agent_session',
        callerSessionId: null,
      });
      expect(result).toEqual({ allowed: false, reason: 'non_human_caller' });
    });

    test('a session-bound connector PAT without a service account (legacy) is still refused', () => {
      // Legacy connector tokens authorize AS the user but carry a session id —
      // the session-bound refusal (the self-approval guard) catches them.
      const result = mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: HUMAN,
        callerAuthType: 'pat',
        callerCredentialKind: 'pat',
        callerSessionId: 'sess-own-session',
      });
      expect(result).toEqual({ allowed: false, reason: 'session_bound_caller' });
    });

    test('an unresolved actor (no credential kind) stays refused', () => {
      // A request that never resolved an actor has no human behind it.
      const result = mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'user',
        targetSessionCreatedBy: HUMAN,
        callerUserId: HUMAN,
        callerAuthType: 'pat',
        callerCredentialKind: null,
        callerSessionId: null,
      });
      expect(result).toEqual({ allowed: false, reason: 'non_human_caller' });
    });
  });
});

// KRTX-1724: a viewer who may not decide is told who does. The class must be
// the one the verdict enforces.
describe('approvalResolvers', () => {
  test('a session one person started: managers and that launcher', () => {
    expect(approvalResolvers({ targetSessionOrigin: 'user', targetSessionCreatedBy: HUMAN })).toBe(
      'managers_and_launcher',
    );
    expect(approvalResolvers({ targetSessionOrigin: 'trigger', targetSessionCreatedBy: HUMAN })).toBe(
      'managers_and_launcher',
    );
  });

  test('a backend session (CLI PAT, service account, API key): managers only', () => {
    expect(approvalResolvers({ targetSessionOrigin: 'backend', targetSessionCreatedBy: WRAPPER })).toBe(
      'managers',
    );
  });

  test('a session with no creator: managers only', () => {
    expect(approvalResolvers({ targetSessionOrigin: 'user', targetSessionCreatedBy: null })).toBe('managers');
  });

  test('managers only means the launcher really is refused', () => {
    const verdict = (targetSessionOrigin: string) =>
      mayResolveApproval({
        isManager: false,
        targetSessionOrigin,
        targetSessionCreatedBy: HUMAN,
        callerUserId: HUMAN,
        callerAuthType: 'supabase',
        callerCredentialKind: 'jwt',
        callerSessionId: null,
      }).allowed;
    expect(verdict('backend')).toBe(false);
    expect(verdict('user')).toBe(true);
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

describe('non-human credentials cannot resolve approvals', () => {
  test('a service-account bearer cannot relay a decision', () => {
    expect(
      mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: 'wrapper-service-account-id',
        callerAuthType: 'service_account',
        callerCredentialKind: 'service_account',
        callerSessionId: null,
      }).allowed,
    ).toBe(false);
  });

  test('a service account WITHOUT manager rights still cannot resolve', () => {
    expect(
      mayResolveApproval({
        isManager: false,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: 'some-service-account',
        callerAuthType: 'service_account',
        callerCredentialKind: 'service_account',
        callerSessionId: null,
      }).allowed,
    ).toBe(false);
  });
});

describe('the browser human (regression: the Supabase sessionId collision)', () => {
  test('a manager whose caller session is null CAN resolve — this is the dashboard', () => {
    // `supabaseAuth` sets c.get('sessionId') to the SUPABASE AUTH session, and
    // threading that raw value in as callerSessionId made this branch
    // unreachable: every logged-in human tripped the session-bound refusal
    // above and got 403 "An agent cannot resolve its own approval" on every
    // approval, forever. callerKortixSessionId() is what keeps it null here.
    const result = mayResolveApproval({
      isManager: true,
      targetSessionOrigin: 'backend',
      targetSessionCreatedBy: WRAPPER,
      callerUserId: HUMAN,
      callerAuthType: 'supabase',
      callerCredentialKind: 'jwt',
      callerSessionId: null,
    });
    expect(result).toEqual({ allowed: true });
  });

  test('a browser human still sees a session’s approvals when unbound', () => {
    // Same collision: comparing a Supabase auth-session UUID to a Kortix session
    // id made needs-input return 0 for every browser caller.
    expect(
      maySeeSessionApprovals({
        isManager: true,
        callerSessionId: null,
        callerUserId: HUMAN,
        targetSessionId: 'sess-xyz',
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
      }),
    ).toBe(true);
  });

  test('but a genuinely session-bound caller is STILL refused', () => {
    // The fix must not weaken the guard it was protecting.
    expect(
      mayResolveApproval({
        isManager: true,
        targetSessionOrigin: 'backend',
        targetSessionCreatedBy: WRAPPER,
        callerUserId: WRAPPER,
        callerAuthType: 'supabase',
        callerCredentialKind: 'jwt',
        callerSessionId: 'sess-real-kortix-session',
      }).allowed,
    ).toBe(false);
  });
});
