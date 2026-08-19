import { describe, expect, test } from 'bun:test';

import {
  callerHasManagerStanding,
  isAdminBypassEligible,
  shouldApplyAdminBypass,
} from './access';

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
