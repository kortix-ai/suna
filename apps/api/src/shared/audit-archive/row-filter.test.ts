import { describe, expect, test } from 'bun:test';
import type { AuditFilterInput } from '../../accounts/audit-filters';
import { matchesLike, normalizeInstant, rowMatches } from './row-filter';

const none: AuditFilterInput = { actor: null, actionPrefix: null, resourceType: null, sinceRaw: null, untilRaw: null, q: null };
const row = {
  event_id: '00000000-0000-4000-8000-000000000001',
  account_id: 'a7b00000-0000-4000-a000-000000000001',
  occurred_at: '2026-07-07T10:00:00.123456Z',
  action: 'iam.group.create',
  resource_type: 'project_session',
  resource_id: 'Res_ID-1',
  actor_user_id: 'a7b00000-0000-4000-a000-0000000000a1',
  actor_type: 'human',
  authoritative_source: 'api',
  project_id: 'a7b00000-0000-4000-a000-0000000000b1',
  session_id: 'sess-1',
  phase: 'completed',
  outcome: 'success',
  request_id: 'req-1',
  trace_id: null,
  correlation_id: null,
  credential_kind: null,
};
const ACCOUNT = 'a7b00000-0000-4000-a000-000000000001';
const match = (filters: Partial<AuditFilterInput>, r: Record<string, unknown> = row) => rowMatches(r, ACCOUNT, { ...none, ...filters });

describe('normalizeInstant', () => {
  test('keeps microseconds, pads short fractions, converts offsets to UTC', () => {
    expect(normalizeInstant('2026-07-07T10:00:00.123456Z')).toBe('2026-07-07T10:00:00.123456Z');
    expect(normalizeInstant('2026-07-07T10:00:00.5Z')).toBe('2026-07-07T10:00:00.500000Z');
    expect(normalizeInstant('2026-07-07T12:00:00.123456+02:00')).toBe('2026-07-07T10:00:00.123456Z');
    expect(normalizeInstant('2026-07-07T10:00:00Z')).toBe('2026-07-07T10:00:00.000000Z');
  });
});

describe('rowMatches mirrors the SQL filters of buildFilters', () => {
  test('account is always required', () => {
    expect(rowMatches({ ...row, account_id: 'other' }, ACCOUNT, none)).toBe(false);
    expect(match({})).toBe(true);
  });
  test('equality filters', () => {
    expect(match({ actor: row.actor_user_id })).toBe(true);
    expect(match({ actor: 'x' })).toBe(false);
    expect(match({ projectId: row.project_id, sessionId: 'sess-1', actorType: 'human', source: 'api', phase: 'completed', outcome: 'success', requestId: 'req-1' })).toBe(true);
    expect(match({ outcome: 'failure' })).toBe(false);
    expect(match({ correlationId: 'c' })).toBe(false);
  });
  test('action prefixes: a dotted prefix matches itself and its children; connector. also matches computer.', () => {
    expect(match({ actionPrefix: 'iam.group' })).toBe(true);
    expect(match({ actionPrefix: 'iam.group.create' })).toBe(true);
    expect(match({ actionPrefix: 'iam.gro' })).toBe(false); // dotted, not a segment boundary
    expect(match({ actionPrefix: 'iam.' })).toBe(true);
    expect(match({ actionPrefix: 'iam' })).toBe(true); // plain prefix
    expect(match({ actionPrefix: 'connector.' }, { ...row, action: 'computer.shell' })).toBe(true);
  });
  test('resource_type prefix, case sensitive', () => {
    expect(match({ resourceType: 'project' })).toBe(true);
    expect(match({ resourceType: 'Project' })).toBe(false);
  });
  test('since / until are inclusive and compare microseconds', () => {
    expect(match({ sinceRaw: '2026-07-07T10:00:00.123Z' })).toBe(true);
    expect(match({ sinceRaw: '2026-07-07T10:00:00.124Z' })).toBe(false);
    expect(match({ untilRaw: '2026-07-07T10:00:00.123Z' })).toBe(false); // .123456 > .123
    expect(match({ untilRaw: '2026-07-07T10:00:00.124Z' })).toBe(true);
  });
  test('q is a case-insensitive ILIKE substring: % and _ in the term are literal, project id matches as text', () => {
    expect(match({ q: 'res_id' })).toBe(true);
    expect(match({ q: 'RES_ID-1' })).toBe(true);
    expect(match({ q: 'res%1' })).toBe(false);
    expect(match({ q: 'nothing' })).toBe(false);
    expect(match({ q: row.project_id.slice(0, 8) })).toBe(true);
  });
  test('credential_kind needs a row from 2026-09-30 on', () => {
    expect(match({ credentialKind: 'api_key' }, { ...row, credential_kind: 'api_key' })).toBe(false); // July row
    expect(match({ credentialKind: 'api_key' }, { ...row, credential_kind: 'api_key', occurred_at: '2026-10-02T00:00:00.000000Z' })).toBe(true);
  });
});

describe('LIKE matching is linear (no regex built from user input)', () => {
  test('a pathological q term against a long value finishes fast and does not match', () => {
    const row = { account_id: 'acct', occurred_at: '2026-07-01T00:00:00.000Z', action: 'a'.repeat(20_000) };
    const started = performance.now();
    const matched = rowMatches(row, 'acct', { q: '%a'.repeat(40) + 'b' } as never);
    expect(matched).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('q terms are literal (no wildcards, no regex), case-insensitive; the matcher still honours % and _ in a pattern', () => {
    const row = { account_id: 'acct', occurred_at: '2026-07-01T00:00:00.000Z', action: 'iam.role.(create)+', resource_type: 'role' };
    expect(rowMatches(row, 'acct', { q: 'ROLE.(C' } as never)).toBe(true);
    expect(rowMatches(row, 'acct', { q: 'r_le.(' } as never)).toBe(false);
    expect(matchesLike('role.(', 'r_le.%', true)).toBe(true);
    expect(rowMatches(row, 'acct', { q: 'role.x' } as never)).toBe(false);
    expect(rowMatches(row, 'acct', { actionPrefix: 'iam.' } as never)).toBe(true);
    expect(rowMatches(row, 'acct', { actionPrefix: 'Iam.' } as never)).toBe(false);
    expect(rowMatches(row, 'acct', { resourceType: 'ro' } as never)).toBe(true);
  });
});


describe('matchesLike escapes', () => {
  test('a backslash makes `%` and `_` literal, and `\\\\` a literal backslash', () => {
    expect(matchesLike('50%', '50\\%', false)).toBe(true);
    expect(matchesLike('500', '50\\%', false)).toBe(false);
    expect(matchesLike('a_b', 'a\\_b', false)).toBe(true);
    expect(matchesLike('axb', 'a\\_b', false)).toBe(false);
    expect(matchesLike('a\\b', 'a\\\\b', false)).toBe(true);
    expect(matchesLike('anything', '%', false)).toBe(true);
  });
});
