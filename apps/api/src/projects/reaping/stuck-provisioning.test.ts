import { describe, expect, test } from 'bun:test';
import {
  STUCK_WITHOUT_LEASE_MS,
  decideStuckProvisioning,
  provisioningOwnerLapsed,
} from './stuck-provisioning';
import { removalBackoffMs, shouldAttemptRemoval } from './archived-box-removal';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('provisioningOwnerLapsed — who may still finish a provisioning row', () => {
  test('a live restart lease keeps the row with its owner', () => {
    const metadata = {
      runtimeRestartId: 'r1',
      runtimeRestartLeaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    expect(provisioningOwnerLapsed(metadata, minutesAgo(3), NOW)).toBe(false);
  });

  test('an expired restart lease means the restart task is gone', () => {
    const metadata = {
      runtimeRestartId: 'r1',
      runtimeRestartLeaseExpiresAt: minutesAgo(1).toISOString(),
    };
    expect(provisioningOwnerLapsed(metadata, minutesAgo(5), NOW)).toBe(true);
  });

  test('an expired recovery lease means the recovery owner is gone', () => {
    const metadata = {
      runtimeRecoveryLeaseId: 'l1',
      runtimeRecoveryLeaseExpiresAtMs: NOW.getTime() - 1,
    };
    expect(provisioningOwnerLapsed(metadata, minutesAgo(11), NOW)).toBe(true);
    expect(
      provisioningOwnerLapsed(
        { runtimeRecoveryLeaseId: 'l1', runtimeRecoveryLeaseExpiresAtMs: NOW.getTime() + 1 },
        minutesAgo(11),
        NOW,
      ),
    ).toBe(false);
  });

  test('a row with no lease is left alone until it has not changed for the stuck window', () => {
    const recent = new Date(NOW.getTime() - STUCK_WITHOUT_LEASE_MS + 60_000);
    expect(provisioningOwnerLapsed({}, recent, NOW)).toBe(false);
    expect(provisioningOwnerLapsed({}, new Date(NOW.getTime() - STUCK_WITHOUT_LEASE_MS), NOW)).toBe(
      true,
    );
  });
});

describe('decideStuckProvisioning — converge to what the provider says', () => {
  const base = { providerStatus: 'running', sessionDeleted: false, wakeInProgress: false, ownerLapsed: true };

  test('a started box becomes an active row the reaper and Stop can act on', () => {
    expect(decideStuckProvisioning(base)).toBe('activate');
  });

  test('a stopped box parks the row', () => {
    expect(decideStuckProvisioning({ ...base, providerStatus: 'stopped' })).toBe('park');
  });

  test('a removed box preserves the identity as lost', () => {
    expect(decideStuckProvisioning({ ...base, providerStatus: 'removed' })).toBe('preserve-lost');
  });

  test('a deleted session is archived and its box removed, whatever the provider says', () => {
    for (const providerStatus of ['running', 'stopped', 'unknown']) {
      expect(decideStuckProvisioning({ ...base, providerStatus, sessionDeleted: true })).toBe(
        'archive-remove',
      );
    }
  });

  test('an unknown or transitional status proves nothing and changes nothing', () => {
    for (const providerStatus of ['unknown', 'terminal', 'starting']) {
      expect(decideStuckProvisioning({ ...base, providerStatus })).toBe('skip');
    }
  });

  test('a live owner or a live wake always wins', () => {
    expect(decideStuckProvisioning({ ...base, ownerLapsed: false })).toBe('skip');
    expect(decideStuckProvisioning({ ...base, wakeInProgress: true })).toBe('skip');
  });
});

describe('archived-box removal retry schedule', () => {
  test('backs off exponentially from one minute to a six-hour ceiling, never giving up', () => {
    expect(removalBackoffMs(1)).toBe(60_000);
    expect(removalBackoffMs(2)).toBe(120_000);
    expect(removalBackoffMs(5)).toBe(16 * 60_000);
    expect(removalBackoffMs(50)).toBe(6 * 60 * 60_000);
  });

  test('a row is retried only when its retry time has come', () => {
    const nowMs = NOW.getTime();
    expect(shouldAttemptRemoval({ providerAllowed: true, retryAfterMs: null, nowMs })).toBe(true);
    expect(shouldAttemptRemoval({ providerAllowed: true, retryAfterMs: nowMs - 1, nowMs })).toBe(true);
    expect(shouldAttemptRemoval({ providerAllowed: true, retryAfterMs: nowMs + 1, nowMs })).toBe(false);
    expect(shouldAttemptRemoval({ providerAllowed: false, retryAfterMs: null, nowMs })).toBe(false);
  });
});
