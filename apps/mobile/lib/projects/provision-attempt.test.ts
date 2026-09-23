import { describe, expect, test } from 'bun:test';

import {
  ATTEMPT_KEY_TTL_MS,
  attemptFingerprint,
  createAttemptKeys,
  isLostResponseError,
  isProjectLimitError,
  isProvisionInFlightError,
  newestProject,
} from './provision-attempt';

function keys() {
  let n = 0;
  return createAttemptKeys(() => `key-${++n}`);
}

describe('attempt keys', () => {
  test('a retry of the same create reuses its key', () => {
    const k = keys();
    const fp = attemptFingerprint('acct-1', ' Research ');
    expect(k.keyFor(fp, 0)).toBe('key-1');
    expect(k.keyFor(attemptFingerprint('acct-1', 'Research'), 5_000)).toBe('key-1');
  });

  test('another name or account is another create', () => {
    const k = keys();
    expect(k.keyFor(attemptFingerprint('acct-1', 'A'), 0)).toBe('key-1');
    expect(k.keyFor(attemptFingerprint('acct-1', 'B'), 0)).toBe('key-2');
    expect(k.keyFor(attemptFingerprint('acct-2', 'A'), 0)).toBe('key-3');
  });

  test('a success clears the key, so the next create of that name is new', () => {
    const k = keys();
    const fp = attemptFingerprint('acct-1', 'A');
    k.keyFor(fp, 0);
    k.clear(fp);
    expect(k.keyFor(fp, 0)).toBe('key-2');
  });

  test('a key expires after the TTL', () => {
    const k = keys();
    const fp = attemptFingerprint('acct-1', 'A');
    k.keyFor(fp, 0);
    expect(k.keyFor(fp, ATTEMPT_KEY_TTL_MS)).toBe('key-2');
  });
});

describe('provision errors', () => {
  test('project limit, by code or by message', () => {
    expect(isProjectLimitError({ status: 403, code: 'project_limit_reached', message: 'x' })).toBe(true);
    expect(isProjectLimitError(new Error('Free accounts are limited to 1 project'))).toBe(true);
    expect(isProjectLimitError(Object.assign(new Error('Owner or admin role required'), { status: 403 }))).toBe(false);
  });

  test('in flight, by code or by 409 + message', () => {
    expect(isProvisionInFlightError({ status: 409, code: 'provision_in_flight' })).toBe(true);
    expect(
      isProvisionInFlightError(
        Object.assign(new Error('Another provision with this idempotency_key is in flight'), { status: 409 }),
      ),
    ).toBe(true);
    expect(isProvisionInFlightError(Object.assign(new Error('Name taken'), { status: 409 }))).toBe(false);
  });

  test('a lost response has no HTTP status', () => {
    expect(isLostResponseError(new Error('java.net.SocketTimeoutException: timeout'))).toBe(true);
    expect(isLostResponseError(Object.assign(new Error('Network request failed'), { status: 0 }))).toBe(true);
    expect(isLostResponseError(Object.assign(new Error('Bad request'), { status: 400 }))).toBe(false);
    expect(isLostResponseError(null)).toBe(false);
  });
});

describe('newestProject', () => {
  test('the most recently created project, or null', () => {
    expect(newestProject([])).toBeNull();
    expect(
      newestProject([
        { project_id: 'old', created_at: '2026-09-01T00:00:00Z' },
        { project_id: 'new', created_at: '2026-09-24T00:00:00Z' },
      ])?.project_id,
    ).toBe('new');
  });
});
