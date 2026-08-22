/**
 * Pure project-secret sharing logic — the 3 dashboard options + group grants.
 */
import { describe, expect, test } from 'bun:test';
import {
  intentToScope,
  isProjectSessionVisibleTo,
  isSecretUsableBy,
  isSessionTargetVisibleToCaller,
  isSessionVisibleTo,
  parseSharingIntent,
  resolveInheritedSessionSharing,
  scopeToIntent,
  sessionIntentToVisibility,
  visibilityToIntent,
  type SecretGrant,
} from '../connectors/share';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const SALES = 'group-sales';

describe('parseSharingIntent — untrusted body → intent (HTTP gate)', () => {
  test('members keeps departments (groupIds) and members, dropping non-strings', () => {
    const out = parseSharingIntent(
      { mode: 'members', memberIds: ['u1', 42, null], groupIds: ['g1', 'g2', {}] },
      ALICE,
    );
    expect(out).toEqual({ mode: 'members', memberIds: ['u1'], groupIds: ['g1', 'g2'] });
  });

  test('department-only body survives (not silently downgraded to project)', () => {
    expect(parseSharingIntent({ mode: 'members', groupIds: ['g1'] }, ALICE)).toEqual({
      mode: 'members',
      memberIds: [],
      groupIds: ['g1'],
    });
  });

  test('private falls back ownerId to the calling user; project ignores lists', () => {
    expect(parseSharingIntent({ mode: 'private' }, ALICE)).toEqual({ mode: 'private', ownerId: ALICE });
    expect(parseSharingIntent({ mode: 'project', memberIds: ['x'] }, ALICE)).toEqual({ mode: 'project' });
  });
});

describe('isSecretUsableBy', () => {
  test('project scope → everyone', () => {
    expect(isSecretUsableBy('project', [], { userId: ALICE, groupIds: [] })).toBe(true);
  });

  test('restricted → only listed member', () => {
    const grants: SecretGrant[] = [{ principalType: 'member', principalId: ALICE }];
    expect(isSecretUsableBy('restricted', grants, { userId: ALICE, groupIds: [] })).toBe(true);
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: [] })).toBe(false);
  });

  test('restricted → group grant matches by membership', () => {
    const grants: SecretGrant[] = [{ principalType: 'group', principalId: SALES }];
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: [SALES] })).toBe(true);
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: ['group-eng'] })).toBe(false);
  });

  test('restricted with empty grants → nobody', () => {
    expect(isSecretUsableBy('restricted', [], { userId: ALICE, groupIds: [SALES] })).toBe(false);
  });
});

describe('intentToScope — the 3 options', () => {
  test('project wide', () => {
    expect(intentToScope({ mode: 'project' })).toEqual({ shareScope: 'project', grants: [] });
  });

  test('just me → restricted, single member grant', () => {
    expect(intentToScope({ mode: 'private', ownerId: ALICE })).toEqual({
      shareScope: 'restricted',
      grants: [{ principalType: 'member', principalId: ALICE }],
    });
  });

  test('select members (members + groups)', () => {
    expect(intentToScope({ mode: 'members', memberIds: [ALICE, BOB], groupIds: [SALES] })).toEqual({
      shareScope: 'restricted',
      grants: [
        { principalType: 'member', principalId: ALICE },
        { principalType: 'member', principalId: BOB },
        { principalType: 'group', principalId: SALES },
      ],
    });
  });

  test('select members with empty allow-list collapses to project-wide', () => {
    expect(intentToScope({ mode: 'members', memberIds: [], groupIds: [] })).toEqual({
      shareScope: 'project',
      grants: [],
    });
  });
});

describe('scopeToIntent — round-trip for the dashboard', () => {
  test('project', () => {
    expect(scopeToIntent('project', [])).toEqual({ mode: 'project' });
  });

  test('single member → private', () => {
    expect(scopeToIntent('restricted', [{ principalType: 'member', principalId: ALICE }])).toEqual({
      mode: 'private',
      ownerId: ALICE,
    });
  });

  test('multiple / group → members', () => {
    expect(
      scopeToIntent('restricted', [
        { principalType: 'member', principalId: ALICE },
        { principalType: 'group', principalId: SALES },
      ]),
    ).toEqual({ mode: 'members', memberIds: [ALICE], groupIds: [SALES] });
  });

  test('intent → scope → intent is stable', () => {
    for (const intent of [
      { mode: 'project' } as const,
      { mode: 'private', ownerId: ALICE } as const,
      { mode: 'members', memberIds: [ALICE, BOB], groupIds: [SALES] } as const,
    ]) {
      const { shareScope, grants } = intentToScope(intent);
      expect(intentToScope(scopeToIntent(shareScope, grants))).toEqual({ shareScope, grants });
    }
  });
});

const WRAPPER = 'wrapper-service-account';
// Non-KaaB default: an interactive session, caller not session-bound.
const INTERACTIVE = {
  origin: 'interactive',
  sessionId: 's1',
  callerSessionId: null,
  boundCredentialSessionId: null,
};

describe('session sharing — default private; team-wide or select-members', () => {
  test('owner always sees their own session, regardless of visibility', () => {
    expect(isSessionVisibleTo('private', ALICE, [], { userId: ALICE, groupIds: [] }, INTERACTIVE)).toBe(true);
    expect(isSessionVisibleTo('private', ALICE, [], { userId: BOB, groupIds: [] }, INTERACTIVE)).toBe(false);
  });

  // ── Kortix-as-a-Backend isolation ──
  // Every KaaB session is created by the SAME wrapper credential, so created_by
  // is identical for every end-user. The ownership short-circuit above therefore
  // makes every backend session look owned by whoever asks — which, for a token
  // bound to one end-user's sandbox, is a cross-end-user disclosure. The prompt
  // that drives that sandbox is untrusted by construction in KaaB.
  test('a sandbox token cannot reach a DIFFERENT backend session via shared created_by', () => {
    const wrapper = { userId: WRAPPER, groupIds: [] };
    expect(
      isSessionVisibleTo('private', WRAPPER, [], wrapper, {
        origin: 'backend',
        sessionId: 'session-of-end-user-b',
        callerSessionId: 'session-of-end-user-a',
        boundCredentialSessionId: 'session-of-end-user-a',
      }),
    ).toBe(false);
  });

  test('a sandbox token still reaches its OWN backend session', () => {
    expect(
      isSessionVisibleTo('private', WRAPPER, [], { userId: WRAPPER, groupIds: [] }, {
        origin: 'backend',
        sessionId: 'session-a',
        callerSessionId: 'session-a',
        boundCredentialSessionId: 'session-a',
      }),
    ).toBe(true);
  });

  test('the wrapper backend itself (not session-bound) still sees every session it created', () => {
    // The operator API must keep working — this is the wrapper's own credential,
    // acting for nobody in particular, so created_by ownership is legitimate.
    expect(
      isSessionVisibleTo('private', WRAPPER, [], { userId: WRAPPER, groupIds: [] }, {
        origin: 'backend',
        sessionId: 'session-b',
        callerSessionId: null,
        boundCredentialSessionId: null,
      }),
    ).toBe(true);
  });

  test('interactive sessions are untouched — a sandbox token still lists its siblings', () => {
    // created_by genuinely IS one person for interactive sessions, so narrowing
    // here would break `kortix sessions ls` from inside a normal sandbox.
    expect(
      isSessionVisibleTo('private', ALICE, [], { userId: ALICE, groupIds: [] }, {
        origin: 'interactive',
        sessionId: 'other-session',
        callerSessionId: 'my-session',
        boundCredentialSessionId: 'my-session',
      }),
    ).toBe(true);
  });

  test('project visibility → every member', () => {
    expect(isSessionVisibleTo('project', ALICE, [], { userId: BOB, groupIds: [] }, INTERACTIVE)).toBe(true);
  });

  test('restricted → owner + member/group grants only', () => {
    const grants: SecretGrant[] = [
      { principalType: 'member', principalId: BOB },
      { principalType: 'group', principalId: SALES },
    ];
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: BOB, groupIds: [] }, INTERACTIVE)).toBe(true);
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: 'carol', groupIds: [SALES] }, INTERACTIVE)).toBe(true);
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: 'carol', groupIds: [] }, INTERACTIVE)).toBe(false);
  });

  test('intent ⇄ visibility round-trips', () => {
    expect(sessionIntentToVisibility({ mode: 'project' })).toEqual({ visibility: 'project', grants: [] });
    expect(sessionIntentToVisibility({ mode: 'private', ownerId: ALICE })).toEqual({ visibility: 'private', grants: [] });
    // Empty members collapses to private (owner only).
    expect(sessionIntentToVisibility({ mode: 'members', memberIds: [] })).toEqual({ visibility: 'private', grants: [] });
    const members = sessionIntentToVisibility({ mode: 'members', memberIds: [BOB], groupIds: [SALES] });
    expect(members.visibility).toBe('restricted');
    expect(members.grants).toHaveLength(2);

    expect(visibilityToIntent('project', [])).toEqual({ mode: 'project' });
    expect(visibilityToIntent('private', [])).toEqual({ mode: 'private', ownerId: '' });
    expect(visibilityToIntent('restricted', members.grants)).toEqual({ mode: 'members', memberIds: [BOB], groupIds: [SALES] });
  });
});

describe('resolveInheritedSessionSharing — a spawned worker inherits its parent', () => {
  test('no parent (no spawning session) → default private, no grants', () => {
    expect(resolveInheritedSessionSharing(undefined, null)).toEqual({
      visibility: 'private',
      grants: [],
    });
  });

  test('parent shared project-wide → worker is project-wide too', () => {
    expect(resolveInheritedSessionSharing(undefined, { visibility: 'project', grants: [] })).toEqual({
      visibility: 'project',
      grants: [],
    });
  });

  test('parent shared with select members → worker copies the same grants', () => {
    const grants: SecretGrant[] = [{ principalType: 'member', principalId: BOB }];
    expect(resolveInheritedSessionSharing(undefined, { visibility: 'restricted', grants })).toEqual({
      visibility: 'restricted',
      grants,
    });
  });

  test('parent private → worker stays private (unchanged default)', () => {
    expect(resolveInheritedSessionSharing(undefined, { visibility: 'private', grants: [] })).toEqual({
      visibility: 'private',
      grants: [],
    });
  });

  test('an explicit requested visibility always wins, even with a parent present', () => {
    // Automation callers (triggers, channels) pin their own visibility and
    // must never inherit — this is what stops that regressing.
    expect(
      resolveInheritedSessionSharing('project', { visibility: 'restricted', grants: [{ principalType: 'member', principalId: BOB }] }),
    ).toEqual({ visibility: 'project', grants: [] });
    expect(resolveInheritedSessionSharing('private', { visibility: 'project', grants: [] })).toEqual({
      visibility: 'private',
      grants: [],
    });
  });
});

describe('trigger-created session visibility', () => {
  const metadata = {
    source: 'trigger:scheduler',
    trigger_kind: 'git',
    trigger_slug: 'daily-review',
  };
  const serviceAccount = 'trigger-agent-service-account';

  test('project manager can open a private trigger-created session', () => {
    expect(isProjectSessionVisibleTo(
      'private', serviceAccount, [], { userId: ALICE, groupIds: [] }, INTERACTIVE,
      { metadata, canManageProject: true },
    )).toBe(true);
  });

  test('ordinary project member cannot open a private trigger-created session', () => {
    expect(isProjectSessionVisibleTo(
      'private', serviceAccount, [], { userId: ALICE, groupIds: [] }, INTERACTIVE,
      { metadata, canManageProject: false },
    )).toBe(false);
  });

  test('manager still cannot open an ordinary private human session', () => {
    expect(isProjectSessionVisibleTo(
      'private', BOB, [], { userId: ALICE, groupIds: [] }, INTERACTIVE,
      { metadata: {}, canManageProject: true },
    )).toBe(false);
  });

  test('trigger agent service account remains the private-session owner', () => {
    expect(isProjectSessionVisibleTo(
      'private', serviceAccount, [], { userId: serviceAccount, groupIds: [] }, INTERACTIVE,
      { metadata, canManageProject: false },
    )).toBe(true);
  });

  test('selected grants and project visibility keep their existing behavior', () => {
    expect(isProjectSessionVisibleTo(
      'restricted', serviceAccount,
      [{ principalType: 'member', principalId: ALICE }],
      { userId: ALICE, groupIds: [] }, INTERACTIVE,
      { metadata, canManageProject: false },
    )).toBe(true);
    expect(isProjectSessionVisibleTo(
      'project', serviceAccount, [], { userId: ALICE, groupIds: [] }, INTERACTIVE,
      { metadata, canManageProject: false },
    )).toBe(true);
  });

  test('all server trigger metadata fields are required for manager access', () => {
    for (const incomplete of [
      { trigger_kind: 'git', trigger_slug: 'daily-review' },
      { source: 'ui', trigger_kind: 'git', trigger_slug: 'daily-review' },
      { source: 'trigger:scheduler', trigger_kind: 'git' },
      { source: 'trigger:scheduler', trigger_slug: 'daily-review' },
      { trigger_kind: 'git' },
      { trigger_slug: 'daily-review' },
      { trigger_kind: 'git', trigger_slug: '' },
      null,
    ]) {
      expect(isProjectSessionVisibleTo(
        'private', serviceAccount, [], { userId: ALICE, groupIds: [] }, INTERACTIVE,
        { metadata: incomplete, canManageProject: true },
      )).toBe(false);
    }
  });

  /*
   * The override belongs to the HUMAN, not to a token bound to one session.
   *
   * Two failure modes are pinned here, and they pull in opposite directions.
   * The hole: a session-bound AGENT token whose launching user holds `manage`
   * read every other trigger-created private session in the project — the
   * interactive origin sails past `isSessionTargetVisibleToCaller`, which only
   * narrows `backend`-origin targets. The regression: gating that on
   * `callerSessionId` instead 403s ordinary dashboard users, because
   * `resolveSupabaseAuth` puts the SUPABASE LOGIN session id in that field for
   * every signed-in human. Hence the separate `boundCredentialSessionId`.
   */
  const BOUND_AGENT = {
    origin: 'interactive',
    sessionId: 'trigger-session-b',
    callerSessionId: 'agent-session-a',
    boundCredentialSessionId: 'agent-session-a',
  };
  /** A signed-in human. `callerSessionId` is their Supabase LOGIN session id —
   *  non-null — while the agent binding is null. */
  const BROWSER_MANAGER = {
    origin: 'interactive',
    sessionId: 'trigger-session-b',
    callerSessionId: 'supabase-login-session-id',
    boundCredentialSessionId: null,
  };

  test('a session-bound agent token does NOT get the manager override', () => {
    expect(isProjectSessionVisibleTo(
      'private', serviceAccount, [], { userId: ALICE, groupIds: [] }, BOUND_AGENT,
      { metadata, canManageProject: true },
    )).toBe(false);
  });

  test('an unbound browser manager STILL gets the override, Supabase session id and all', () => {
    // The case Strix's suggested diff broke. A non-null `callerSessionId` is
    // the normal state for a logged-in human, so it can never mean "an agent".
    expect(isProjectSessionVisibleTo(
      'private', serviceAccount, [], { userId: ALICE, groupIds: [] }, BROWSER_MANAGER,
      { metadata, canManageProject: true },
    )).toBe(true);
  });

  test('the owner still sees their own session, bound or not', () => {
    expect(isProjectSessionVisibleTo(
      'private', ALICE, [], { userId: ALICE, groupIds: [] }, BOUND_AGENT,
      { metadata, canManageProject: false },
    )).toBe(true);
    expect(isProjectSessionVisibleTo(
      'private', ALICE, [], { userId: ALICE, groupIds: [] }, BROWSER_MANAGER,
      { metadata, canManageProject: false },
    )).toBe(true);
  });

  test('a bound agent keeps what stored visibility already granted it', () => {
    // Losing the override must not cost it project-wide sessions or an
    // explicit grant — it only stops the manager shortcut.
    expect(isProjectSessionVisibleTo(
      'project', serviceAccount, [], { userId: ALICE, groupIds: [] }, BOUND_AGENT,
      { metadata, canManageProject: true },
    )).toBe(true);
    expect(isProjectSessionVisibleTo(
      'restricted', serviceAccount,
      [{ principalType: 'member', principalId: ALICE }],
      { userId: ALICE, groupIds: [] }, BOUND_AGENT,
      { metadata, canManageProject: true },
    )).toBe(true);
  });

  test('manager access never bypasses backend sibling-session isolation', () => {
    expect(isProjectSessionVisibleTo(
      'private', serviceAccount, [], { userId: ALICE, groupIds: [] },
      {
        origin: 'backend',
        sessionId: 'trigger-session-b',
        callerSessionId: 'trigger-session-a',
        boundCredentialSessionId: 'trigger-session-a',
      },
      { metadata, canManageProject: true },
    )).toBe(false);
  });
});

/**
 * The SHARING path must obey the same KaaB narrowing as the read path.
 *
 * `loadSessionForSharing` is a separate helper from `loadVisibleSession`, and
 * the commit that threaded `callerSessionId` through every visibility check
 * enumerated the latter's call sites and missed this one. Sharing is the worst
 * place to miss: a public share is UNAUTHENTICATED and its router is mounted
 * before auth, so a mint against another end-user's session exposes their live
 * app port and workspace files to anyone with the URL.
 */
describe('KaaB: sharing is not exempt from the isolation narrowing', () => {
  const WRAPPER = 'wrapper-service-account';

  test("one end-user's sandbox may not manage sharing on another's session", () => {
    // Same shape as the read path: shared creator, backend origin, different
    // caller session. If this returns true, A can mint a public URL onto B.
    expect(
      isSessionVisibleTo('private', WRAPPER, [], { userId: WRAPPER, groupIds: [] }, {
        origin: 'backend',
        sessionId: 'session-of-end-user-b',
        callerSessionId: 'session-of-end-user-a',
        boundCredentialSessionId: 'session-of-end-user-a',
      }),
    ).toBe(false);
  });

  test('a sandbox may still manage sharing on its OWN session', () => {
    expect(
      isSessionVisibleTo('private', WRAPPER, [], { userId: WRAPPER, groupIds: [] }, {
        origin: 'backend',
        sessionId: 'session-a',
        callerSessionId: 'session-a',
        boundCredentialSessionId: 'session-a',
      }),
    ).toBe(true);
  });

  test('a human project member reaches the sharing permission check', () => {
    expect(
      isSessionTargetVisibleToCaller({
        origin: 'user',
        sessionId: 'private-session',
        callerSessionId: null,
        boundCredentialSessionId: null,
      }),
    ).toBe(true);
  });

  test("a session-bound backend credential cannot target another end-user's session", () => {
    expect(
      isSessionTargetVisibleToCaller({
        origin: 'backend',
        sessionId: 'session-of-end-user-b',
        callerSessionId: 'session-of-end-user-a',
        boundCredentialSessionId: 'session-of-end-user-a',
      }),
    ).toBe(false);
  });
});
