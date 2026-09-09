/**
 * The audit pool's timeout budget and the contention classifier that decides
 * whether a failed audit write is backpressure or a defect.
 *
 * Essentia 2026-08-26: POST /v1/projects/:p/sessions/:s/audit/events returned
 * 500 [57014] 445 times in 3 hours, each after ~10s, while pg_stat_activity
 * showed `insert into "kortix"."audit_events"` blocking other
 * `insert into "kortix"."audit_events"` in chained pids.
 */
import { describe, expect, test } from 'bun:test';
import { AUDIT_LOCK_TIMEOUT_MS_DEFAULT, AUDIT_STATEMENT_TIMEOUT_MS_DEFAULT, auditErrorSqlstate, isAuditContentionError } from './audit-db';

describe('audit pool timeout budget', () => {
  test('a lock wait is capped well below the statement budget', () => {
    // A lock wait is not work. Burning the whole statement_timeout on one means
    // a blocked writer holds one of only DEFAULT_AUDIT_POOL_MAX (2) backends
    // for 10s. Reproduced against a 5.09M-row audit_events: the same blocked
    // insert died at 10,004.957 ms (57014) with no lock_timeout and at
    // 2,503.721 ms (55P03) with it.
    expect(AUDIT_LOCK_TIMEOUT_MS_DEFAULT).toBe(2_500);
    expect(AUDIT_LOCK_TIMEOUT_MS_DEFAULT).toBeLessThan(AUDIT_STATEMENT_TIMEOUT_MS_DEFAULT / 2);
  });
});

describe('isAuditContentionError', () => {
  const contention = [
    ['57014', 'statement_timeout while queued on the session sequence lock'],
    ['55P03', 'lock_timeout'],
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
  ] as const;

  for (const [code, why] of contention) {
    test(`${code} is retryable backpressure (${why})`, () => {
      expect(isAuditContentionError(Object.assign(new Error(why), { code }))).toBe(true);
    });
  }

  test('a wrapped driver error is still recognized', () => {
    const cause = Object.assign(new Error('canceling statement'), { code: '57014' });
    expect(isAuditContentionError(Object.assign(new Error('insert failed'), { cause }))).toBe(true);
  });

  test('a constraint violation is a defect, not backpressure', () => {
    // Reporting 23505 as retryable would make the sandbox relay re-send a batch
    // that can never land.
    expect(
      isAuditContentionError(Object.assign(new Error('duplicate key'), { code: '23505' })),
    ).toBe(false);
  });

  test('non-database failures are never laundered into backpressure', () => {
    expect(isAuditContentionError(new Error('boom'))).toBe(false);
    expect(isAuditContentionError(null)).toBe(false);
    expect(isAuditContentionError('57014')).toBe(false);
  });

  test('a self-referencing cause cannot loop', () => {
    const error: { code?: string; cause?: unknown } = {};
    error.cause = error;
    expect(isAuditContentionError(error)).toBe(false);
  });
});

describe('auditErrorSqlstate', () => {
  test('reads the SQLSTATE off a Drizzle wrapper whose pg error is the cause', () => {
    // The prod shape: DrizzleQueryError prints the statement and every bound
    // parameter and no code at all — the pg error hangs off `cause`.
    const cause = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const wrapper = Object.assign(new Error('Failed query: insert into "kortix"."audit_events"'), {
      cause,
    });
    expect(auditErrorSqlstate(wrapper)).toBe('57014');
  });

  test('finds a SQLSTATE nested more than one level down', () => {
    const pg = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const inner = Object.assign(new Error('inner'), { cause: pg });
    expect(auditErrorSqlstate(Object.assign(new Error('outer'), { cause: inner }))).toBe('40P01');
  });

  test('answers null rather than inventing a code', () => {
    expect(auditErrorSqlstate(new Error('boom'))).toBeNull();
    expect(auditErrorSqlstate(null)).toBeNull();
    expect(auditErrorSqlstate('57014')).toBeNull();
    expect(auditErrorSqlstate(Object.assign(new Error('x'), { code: '' }))).toBeNull();
  });

  test('a self-referencing cause cannot loop', () => {
    const error: { code?: string; cause?: unknown } = {};
    error.cause = error;
    expect(auditErrorSqlstate(error)).toBeNull();
  });
});
