import { describe, expect, test } from 'bun:test';
import { interpretAcquireResult, shouldDemote } from '../shared/leader-election';

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
