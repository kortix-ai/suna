import { describe, expect, test } from 'bun:test';
import { describeAuditWriteFailure } from './audit-queue';

// Prod dropped ~600 audit events over 48 hours and not one log line said why.
// The handler passed the DrizzleQueryError straight to console.error, so what
// landed was the whole generated statement — 48 columns, 44 placeholders —
// plus `params:` and every bound value. The SQLSTATE lives on `.cause`.

/** The shape drizzle actually throws: wrapper message is the SQL, code is deeper. */
function drizzleError(driver: { message: string; code?: string }): Error {
  const cause = Object.assign(new Error(driver.message), driver.code ? { code: driver.code } : {});
  return Object.assign(
    new Error(
      'Failed query: insert into "kortix"."audit_events" ("event_id", "account_id", ' +
        '"project_id", "session_id") values (default, $1, $2, $3) on conflict do nothing\n' +
        'params: e7960685,69db1886,13e9a17a,51.158.248.124,Bun/1.3.11',
    ),
    { cause },
  );
}

describe('describeAuditWriteFailure', () => {
  test('leads with the SQLSTATE, which the wrapper message never contains', () => {
    const line = describeAuditWriteFailure(
      drizzleError({ message: 'canceling statement due to statement timeout', code: '57014' }),
    );
    expect(line).toContain('sqlstate=57014');
    expect(line).toContain('canceling statement due to statement timeout');
  });

  test('never echoes the statement or its bound parameters', () => {
    const line = describeAuditWriteFailure(
      drizzleError({ message: 'deadlock detected', code: '40P01' }),
    );
    // The bound values are audit payloads: IPs, user agents, account ids.
    expect(line).not.toContain('51.158.248.124');
    expect(line).not.toContain('Bun/1.3.11');
    expect(line).not.toContain('insert into');
    expect(line).not.toContain('params:');
  });

  test('bounds the line so one failure cannot flood the log', () => {
    const line = describeAuditWriteFailure(
      drizzleError({ message: 'x'.repeat(5000), code: '53300' }),
    );
    expect(line.length).toBeLessThan(400);
    expect(line).toContain('sqlstate=53300');
  });

  test('still says something useful when there is no SQLSTATE', () => {
    const line = describeAuditWriteFailure(new Error('connection terminated unexpectedly'));
    expect(line).toBe('connection terminated unexpectedly');
  });

  test('survives a cause cycle instead of hanging', () => {
    const a = new Error('outer') as Error & { cause?: unknown };
    const b = new Error('inner') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(describeAuditWriteFailure(a)).toContain('inner');
  });

  test('degrades to a fixed string rather than printing undefined', () => {
    expect(describeAuditWriteFailure(null)).toBe('no error message available');
    expect(describeAuditWriteFailure({})).toBe('no error message available');
  });
});
