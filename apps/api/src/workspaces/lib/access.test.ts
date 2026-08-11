import { describe, expect, test } from 'bun:test';

import { isAdminBypassEligible, shouldApplyAdminBypass } from './access';

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
