import { describe, expect, test } from 'bun:test';
import {
  interpretAcquireResult,
  runsSingletonWorkers,
  shouldDemote,
} from '../shared/leader-election';

const ME = 'host-123-abc';
const OTHER = 'host-999-xyz';

describe('interpretAcquireResult', () => {
  test('won when the upsert returns our owner_id (acquired or renewed)', () => {
    expect(interpretAcquireResult([{ owner_id: ME }], ME)).toBe(true);
  });

  test('lost when no row is returned (a non-owning live lease blocks the upsert)', () => {
    expect(interpretAcquireResult([], ME)).toBe(false);
  });

  test('lost when the returned row belongs to another owner', () => {
    // Defensive: the WHERE predicate should never return a foreign owner, but if
    // it ever did we must not claim leadership.
    expect(interpretAcquireResult([{ owner_id: OTHER }], ME)).toBe(false);
  });
});

describe('shouldDemote', () => {
  const TTL = 60_000;

  test('keeps leadership while within the TTL since the last good renew', () => {
    const last = 1_000_000;
    expect(shouldDemote(last, last + 1_000, TTL)).toBe(false);
    expect(shouldDemote(last, last + 59_999, TTL)).toBe(false);
  });

  test('demotes once the last secured lease has fully lapsed', () => {
    const last = 1_000_000;
    expect(shouldDemote(last, last + 60_000, TTL)).toBe(true);
    expect(shouldDemote(last, last + 120_000, TTL)).toBe(true);
  });
});

describe('runsSingletonWorkers (dead-weight-leader guard)', () => {
  test('default (no flags set) → owner, so single-node/self-host still elects', () => {
    expect(runsSingletonWorkers({})).toBe(true);
  });

  test('API-only profile (ALL four worker flags "false") → NOT an owner', () => {
    // This is the helm workers.enabled=false profile. Such a pod must never join
    // the election — otherwise it can win the lease and dead-weight-starve crons.
    expect(
      runsSingletonWorkers({
        KORTIX_TRIGGER_SCHEDULER_ENABLED: 'false',
        KORTIX_PROJECT_MAINTENANCE_ENABLED: 'false',
        KORTIX_LEGACY_MIGRATION_WORKER_ENABLED: 'false',
        KORTIX_SUNA_MIGRATION_WORKER_ENABLED: 'false',
      }),
    ).toBe(false);
  });

  test('any single worker still enabled → owner', () => {
    expect(
      runsSingletonWorkers({
        KORTIX_TRIGGER_SCHEDULER_ENABLED: 'false',
        KORTIX_PROJECT_MAINTENANCE_ENABLED: 'false',
        KORTIX_LEGACY_MIGRATION_WORKER_ENABLED: 'false',
        KORTIX_SUNA_MIGRATION_WORKER_ENABLED: 'true',
      }),
    ).toBe(true);
  });

  test('only the scheduler enabled (others off) → owner', () => {
    expect(
      runsSingletonWorkers({
        KORTIX_TRIGGER_SCHEDULER_ENABLED: 'true',
        KORTIX_PROJECT_MAINTENANCE_ENABLED: 'false',
        KORTIX_LEGACY_MIGRATION_WORKER_ENABLED: 'false',
        KORTIX_SUNA_MIGRATION_WORKER_ENABLED: 'false',
      }),
    ).toBe(true);
  });

  test('only literal "false" disables a flag — "0"/"no"/"" still count as on', () => {
    expect(runsSingletonWorkers({ KORTIX_TRIGGER_SCHEDULER_ENABLED: '0' })).toBe(true);
  });
});
