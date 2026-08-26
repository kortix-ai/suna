import { describe, expect, test } from 'bun:test';

import {
  callerHasManagerStanding,
  isAdminBypassEligible,
  sessionIsTombstoned,
  shouldApplyAdminBypass,
  userIdentityIsCacheable,
  viewerManagerStanding,
} from './access';

/**
 * `resolveUserIdentities` makes one HTTPS call to the Supabase auth admin API
 * per distinct user id, and the session LIST resolves every distinct
 * `created_by` in the project — a network N+1 on the open path. The lookup is
 * now memoized, and this predicate is the safety argument for that: only a
 * positive, non-degraded answer may be kept.
 */
describe('userIdentityIsCacheable', () => {
  test('a resolved user is cacheable', () => {
    expect(
      userIdentityIsCacheable({ email: 'a@b.c', displayName: 'A', exists: true }),
    ).toBe(true);
  });

  test('a resolved user with no email on file is still cacheable', () => {
    // "No email" is a real answer about a real user, not a failure.
    expect(
      userIdentityIsCacheable({ email: null, displayName: null, exists: true }),
    ).toBe(true);
  });

  test('a non-existent user is NEVER cached', () => {
    // A user created a moment ago (invite accepted, SSO JIT) must resolve on
    // the next request, not one TTL window later.
    expect(
      userIdentityIsCacheable({ email: null, displayName: null, exists: false }),
    ).toBe(false);
  });

  test('the transient-failure fallback is NEVER cached', () => {
    // Caching it would pin one network hiccup for a whole TTL window across
    // every caller, and it deliberately claims `exists: true` so a blip cannot
    // hide a real member.
    expect(
      userIdentityIsCacheable({
        email: null,
        displayName: null,
        exists: true,
        transient: true,
      }),
    ).toBe(false);
  });
});

describe('callerHasManagerStanding', () => {
  // `canManageSharing` is `isOwner || canManageProject`, so this predicate also
  // decides the 403 on stop, restart, delete, change-sharing and change-model.

  test('an unbound human manager keeps manager standing', () => {
    expect(callerHasManagerStanding('manager', null)).toBe(true);
  });

  test('a session-bound agent token never carries its user manager standing', () => {
    // The hole: with standing it also gets the trigger-session override in
    // isProjectSessionVisibleTo, reaching sibling private sessions.
    expect(callerHasManagerStanding('manager', 'agent-session-a')).toBe(false);
  });

  test('a non-manager role gains nothing from being unbound', () => {
    expect(callerHasManagerStanding('member', null)).toBe(false);
  });

  test('the Supabase login session id is NOT a binding — it must never reach here', () => {
    // Pinned as documentation of the regression this signature exists to stop:
    // `callerSessionId` is non-null for every signed-in human, so passing THAT
    // value would return false and 403 every dashboard manager. Callers must
    // pass `callerKortixSessionId(c)`, which is null for authType 'supabase'.
    expect(callerHasManagerStanding('manager', null)).toBe(true);
  });
});

describe('viewerManagerStanding', () => {
  // The list/serialization path derives `can_manage_lifecycle` from this, and
  // DELETE derives its 403 from loadVisibleSession's stripped standing — this
  // predicate exists so the two can never disagree again (the 2026-08-20
  // "can_manage_lifecycle:true but deletion denied" incident evidence).

  const probeNever = () => {
    throw new Error('capability probe must not run');
  };

  test('a bound credential is denied before any I/O, whatever the role', async () => {
    expect(await viewerManagerStanding('manager', 'agent-session-a', probeNever as any)).toBe(
      false,
    );
  });

  test('the capability probe cannot resurrect standing for a bound credential', async () => {
    expect(
      await viewerManagerStanding('member', 'agent-session-a', async () => true),
    ).toBe(false);
  });

  test('an unbound manager passes on role alone — no probe', async () => {
    expect(await viewerManagerStanding('manager', null, probeNever as any)).toBe(true);
  });

  test('an unbound non-manager falls through to the capability probe', async () => {
    expect(await viewerManagerStanding('member', null, async () => true)).toBe(true);
    expect(await viewerManagerStanding('member', null, async () => false)).toBe(false);
  });
});

describe('shouldApplyAdminBypass', () => {
  const base = { action: 'read' as const, isServiceAccount: false, bypassHeaderPresent: true };

  test('applies on a read action, header present, confirmed platform admin', () => {
    expect(shouldApplyAdminBypass({ ...base, isPlatformAdmin: true })).toBe(true);
  });

  test('never applies when isPlatformAdmin resolves false, even with everything else true', () => {
    expect(shouldApplyAdminBypass({ ...base, isPlatformAdmin: false })).toBe(false);
  });

  test('never applies for a write/session/manage action — bypass is read-only', () => {
    for (const action of ['write', 'session', 'manage'] as const) {
      expect(shouldApplyAdminBypass({ ...base, action, isPlatformAdmin: true })).toBe(false);
    }
  });

  test('never applies for a service account, even if somehow flagged as a platform admin', () => {
    expect(
      shouldApplyAdminBypass({ ...base, isServiceAccount: true, isPlatformAdmin: true }),
    ).toBe(false);
  });

  test('never applies without the explicit bypass header', () => {
    expect(
      shouldApplyAdminBypass({ ...base, bypassHeaderPresent: false, isPlatformAdmin: true }),
    ).toBe(false);
  });
});

describe('isAdminBypassEligible', () => {
  test('eligible on a read action with the header present and no service account', () => {
    expect(
      isAdminBypassEligible({ action: 'read', isServiceAccount: false, bypassHeaderPresent: true }),
    ).toBe(true);
  });

  test('not eligible for a write/session/manage action', () => {
    for (const action of ['write', 'session', 'manage'] as const) {
      expect(
        isAdminBypassEligible({ action, isServiceAccount: false, bypassHeaderPresent: true }),
      ).toBe(false);
    }
  });

  test('not eligible for a service account', () => {
    expect(
      isAdminBypassEligible({ action: 'read', isServiceAccount: true, bypassHeaderPresent: true }),
    ).toBe(false);
  });

  test('not eligible without the header — the DB round-trip is skipped entirely', () => {
    expect(
      isAdminBypassEligible({ action: 'read', isServiceAccount: false, bypassHeaderPresent: false }),
    ).toBe(false);
  });
});

describe('sessionIsTombstoned — a deleted session refuses every runtime verb', () => {
  test('a string deletedAt tombstones the row', () => {
    expect(
      sessionIsTombstoned({ metadata: { deletedAt: '2026-08-24T14:18:56.979Z' } }),
    ).toBe(true);
  });

  test('a live session is not tombstoned', () => {
    expect(sessionIsTombstoned({ metadata: { warm: true } })).toBe(false);
    expect(sessionIsTombstoned({ metadata: null })).toBe(false);
    expect(sessionIsTombstoned({ metadata: undefined })).toBe(false);
  });

  test('a non-string deletedAt does not tombstone — only the server stamp counts', () => {
    expect(sessionIsTombstoned({ metadata: { deletedAt: 1787580000000 } })).toBe(false);
    expect(sessionIsTombstoned({ metadata: { deletedAt: null } })).toBe(false);
  });

  test('the /start and /restart handlers both ask it after loadVisibleSession', async () => {
    const src = await Bun.file(new URL('../routes/r8.ts', import.meta.url)).text();
    const occurrences = src.split('sessionIsTombstoned(visible.row)').length - 1;
    expect(occurrences).toBe(2);
  });
});
