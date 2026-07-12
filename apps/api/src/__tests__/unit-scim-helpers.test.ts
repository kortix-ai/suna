// Pure SCIM serializer/filter helpers — no DB, safe to run standalone.
import { describe, expect, test } from 'bun:test';
import { buildInviteUser, buildUser, isUnsupportedFilter, parseFilter } from '../scim/app';

describe('parseFilter', () => {
  test('parses the supported `attr eq "value"` form (with whitespace)', () => {
    expect(parseFilter('userName eq "a@b.com"')).toEqual({ attr: 'userName', value: 'a@b.com' });
    expect(parseFilter('  externalId   eq   "x-1"  ')).toEqual({
      attr: 'externalId',
      value: 'x-1',
    });
  });

  test('returns null for a missing or unsupported filter', () => {
    expect(parseFilter(undefined)).toBeNull();
    expect(parseFilter('')).toBeNull();
    expect(parseFilter('userName sw "a"')).toBeNull(); // starts-with, unsupported
    expect(parseFilter('userName eq a@b.com')).toBeNull(); // unquoted
  });
});

describe('isUnsupportedFilter', () => {
  // The whole point: an IdP that sends a filter we can't honor must get a 400,
  // not the entire directory silently. But no filter at all is a valid list-all.
  test('a present-but-unparseable filter is unsupported (→ 400)', () => {
    expect(isUnsupportedFilter('userName sw "admin"')).toBe(true);
    expect(isUnsupportedFilter('meta.lastModified gt "2020"')).toBe(true);
  });

  test('a missing/empty filter is NOT unsupported (→ list all)', () => {
    expect(isUnsupportedFilter(undefined)).toBe(false);
    expect(isUnsupportedFilter('')).toBe(false);
    expect(isUnsupportedFilter('   ')).toBe(false);
  });

  test('a supported filter is NOT unsupported', () => {
    expect(isUnsupportedFilter('userName eq "a@b.com"')).toBe(false);
  });
});

describe('buildUser active flag', () => {
  const member = {
    userId: 'u-1',
    scimExternalId: 'ext-1',
    joinedAt: new Date('2026-01-01T00:00:00Z'),
  };

  test('defaults to active:true for the live read/list/create paths', () => {
    expect(buildUser('acc-1', member, 'a@b.com').active).toBe(true);
  });

  test('reports active:false on the deactivation response so the IdP can confirm', () => {
    const u = buildUser('acc-1', member, 'a@b.com', false);
    expect(u.active).toBe(false);
    expect(u.id).toBe('u-1');
    expect(u.userName).toBe('a@b.com');
    expect(u.externalId).toBe('ext-1');
  });
});

describe('buildInviteUser', () => {
  const invite = {
    inviteId: 'inv-1',
    email: 'new@b.com',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    externalId: 'okta-99',
  };

  test('a pending invite is active:true — the key fix so Okta stops "reactivating"', () => {
    const u = buildInviteUser('acc-1', invite);
    expect(u.active).toBe(true);
    expect(u.id).toBe('inv-1'); // SCIM id = invitation id
    expect(u.userName).toBe('new@b.com');
    expect(u.externalId).toBe('okta-99');
    expect(u.emails[0]).toEqual({ value: 'new@b.com', primary: true });
    expect(u.meta.location).toBe('/scim/v2/accounts/acc-1/Users/inv-1');
  });

  test('reports active:false when the invite is revoked (deprovision response)', () => {
    expect(buildInviteUser('acc-1', invite, false).active).toBe(false);
  });

  test('tolerates a missing externalId (invites without one)', () => {
    const u = buildInviteUser('acc-1', { ...invite, externalId: undefined });
    expect(u.externalId).toBeNull();
  });
});
