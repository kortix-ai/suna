import { describe, expect, test } from 'bun:test';

import {
  endOfLocalDayIso,
  formatDate,
  formatExpiry,
  formatList,
  formatRelative,
  isoToDateInputValue,
  pluralize,
  principalLabel,
  removeAccessCopy,
  shortPrincipalId,
  RBAC_UPSELL_MESSAGE,
} from './access-shared';

describe('principalLabel', () => {
  test('prefers the email', () => {
    expect(principalLabel({ email: 'alice@corp.com', user_id: 'u_1' })).toBe('alice@corp.com');
  });

  test('falls back to the user id when the email is null or empty', () => {
    expect(principalLabel({ email: null, user_id: 'u_1' })).toBe('u_1');
    expect(principalLabel({ email: '', user_id: 'u_1' })).toBe('u_1');
  });

  test('uses a name when there is no email (groups, service identities)', () => {
    expect(principalLabel({ name: 'Platform', user_id: 'g_1' })).toBe('Platform');
  });

  test('is empty for a missing principal rather than throwing', () => {
    expect(principalLabel(null)).toBe('');
    expect(principalLabel(undefined)).toBe('');
  });

  test('shortPrincipalId truncates to 8 characters', () => {
    expect(shortPrincipalId('0123456789abcdef')).toBe('01234567');
  });
});

describe('formatExpiry', () => {
  test('no expiry reads as permanent, not as an unknown', () => {
    expect(formatExpiry(null)).toEqual({ label: 'Never', expired: false, bounded: false });
    expect(formatExpiry(undefined).label).toBe('Never');
  });

  test('a past timestamp is flagged expired', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const result = formatExpiry(past);
    expect(result.expired).toBe(true);
    expect(result.bounded).toBe(true);
    expect(result.label).not.toBe('Never');
  });

  test('a future timestamp is bounded but not expired', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(formatExpiry(future).expired).toBe(false);
    expect(formatExpiry(future).bounded).toBe(true);
  });

  test('an unparseable value degrades to an em dash', () => {
    expect(formatExpiry('not-a-date').label).toBe('—');
  });
});

describe('date helpers', () => {
  test('endOfLocalDayIso anchors to 23:59:59 LOCAL, never UTC midnight', () => {
    const iso = endOfLocalDayIso('2026-08-18');
    expect(iso).toBe(new Date('2026-08-18T23:59:59').toISOString());
    // The whole point: the chosen day is the LAST valid day, so the instant
    // must land on 2026-08-18 in the local zone.
    expect(new Date(iso as string).getDate()).toBe(18);
  });

  test('endOfLocalDayIso returns undefined for empty / invalid input', () => {
    expect(endOfLocalDayIso('')).toBeUndefined();
    expect(endOfLocalDayIso('nope')).toBeUndefined();
  });

  test('isoToDateInputValue round-trips endOfLocalDayIso', () => {
    expect(isoToDateInputValue(endOfLocalDayIso('2026-08-18'))).toBe('2026-08-18');
  });

  test('isoToDateInputValue is empty for no expiry', () => {
    expect(isoToDateInputValue(null)).toBe('');
    expect(isoToDateInputValue(undefined)).toBe('');
  });

  test('formatDate degrades to an em dash', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('garbage')).toBe('—');
    expect(formatDate('2026-08-18T00:00:00.000Z')).not.toBe('—');
  });
});

describe('formatRelative', () => {
  test('walks the minute → hour → day ladder', () => {
    expect(formatRelative(new Date(Date.now() - 10_000))).toBe('just now');
    expect(formatRelative(new Date(Date.now() - 5 * 60_000))).toBe('5m ago');
    expect(formatRelative(new Date(Date.now() - 3 * 3_600_000))).toBe('3h ago');
    expect(formatRelative(new Date(Date.now() - 4 * 86_400_000))).toBe('4d ago');
  });

  test('past 30 days it falls back to an absolute date', () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    expect(formatRelative(old)).not.toContain('ago');
  });

  test('accepts an ISO string as well as a Date', () => {
    expect(formatRelative(new Date(Date.now() - 60_000).toISOString())).toBe('1m ago');
  });

  test('null and unparseable values degrade to an em dash', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative('nope')).toBe('—');
  });
});

describe('removeAccessCopy', () => {
  test('names the principal and the scope', () => {
    expect(removeAccessCopy({ principal: 'alice@corp.com', scopeName: 'Atlas' })).toEqual({
      title: 'Remove access?',
      description: 'alice@corp.com loses access to Atlas.',
    });
  });

  test('an empty inherited list reads as a total removal', () => {
    expect(removeAccessCopy({ principal: 'a', scopeName: 'B', inherited: [] }).description).toBe(
      'a loses access to B.',
    );
  });

  test('inherited groups are appended so nobody expects a full lockout', () => {
    expect(
      removeAccessCopy({ principal: 'a', scopeName: 'B', inherited: ['Engineering'] }).description,
    ).toBe('a loses access to B. They keep the access they get via Engineering.');
    expect(
      removeAccessCopy({ principal: 'a', scopeName: 'B', inherited: ['Eng', 'Ops'] }).description,
    ).toBe('a loses access to B. They keep the access they get via Eng and Ops.');
  });
});

describe('small formatters', () => {
  test('formatList joins with an Oxford-free "and"', () => {
    expect(formatList([])).toBe('');
    expect(formatList(['a'])).toBe('a');
    expect(formatList(['a', 'b'])).toBe('a and b');
    expect(formatList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  test('pluralize', () => {
    expect(pluralize(1, 'project')).toBe('1 project');
    expect(pluralize(0, 'project')).toBe('0 projects');
    expect(pluralize(3, 'project')).toBe('3 projects');
  });
});

test('RBAC_UPSELL_MESSAGE matches the backend 402 wording exactly', () => {
  expect(RBAC_UPSELL_MESSAGE).toBe(
    'Custom roles, policies, and groups are available on the Enterprise plan. Contact sales to enable it.',
  );
});
