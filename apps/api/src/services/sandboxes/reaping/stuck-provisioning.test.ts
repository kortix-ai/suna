import { describe, expect, test } from 'bun:test';
import {
  STUCK_WITHOUT_LEASE_MS,
  decideStuckProvisioning,
  provisioningOwnerLapsed,
} from './stuck-provisioning';

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
