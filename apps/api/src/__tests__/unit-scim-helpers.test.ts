// Pure SCIM serializer/filter helpers — no DB, safe to run standalone.
import { describe, expect, test } from 'bun:test';
import { buildInviteUser, buildUser, isUnsupportedFilter, parseFilter, listResponse } from '../ee/scim/app';

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

/**
 * Deprovisioning through SCIM must revoke the member's YOLO token.
 *
 * Removing the member row is not the whole offboarding: the departed member's
 * YOLO token (the credential their sessions spend under) must die with it, or
 * the removed person keeps a working credential. There are no seats to release:
 * members are unlimited and free.
 *
 * Asserted against the source: SCIM deprovisions through `offboardMember`
 * (accounts/core/offboard-member.ts, shared with removal and leave).
 * `integration-offboard-member.test.ts` drives all three exits end to end.
 */
import { readFileSync as readScimSource } from 'node:fs';
import { join as joinScimPath } from 'node:path';

const SCIM_USERS_SRC = readScimSource(joinScimPath(import.meta.dir, '..', 'ee', 'scim', 'users.ts'), 'utf8');
const OFFBOARD_SRC = readScimSource(
  joinScimPath(import.meta.dir, '..', 'accounts', 'core', 'offboard-member.ts'),
  'utf8',
);

describe('SCIM deprovision revokes the member YOLO token', () => {
  function offboardBody(): string {
    const body = OFFBOARD_SRC.split('export async function offboardMember(')[1]?.split('\n}\n')[0];
    expect(body).toBeTruthy();
    // Guard the extraction: if this stops covering the identity-row delete, every
    // assertion below passes vacuously.
    expect(body).toContain('delete(accountMemberships)');
    return body as string;
  }

  test('SCIM deactivation runs the shared offboarding', () => {
    expect(SCIM_USERS_SRC).toContain("offboardMember(SYSTEM_ACTOR, user.accountId, userId, 'deprovisioned')");
  });

  test('the offboarding awaits revokeYoloTokenForMember after the member row is gone', () => {
    const body = offboardBody();
    expect(body).toContain('await revokeYoloTokenForMember(userId, accountId)');
    expect(body.indexOf('delete(accountMemberships)')).toBeLessThan(body.indexOf('revokeYoloTokenForMember('));
  });

  test('nothing on the path still syncs seats', () => {
    expect(OFFBOARD_SRC).not.toContain('seat-management');
    expect(SCIM_USERS_SRC).not.toContain('seat-management');
  });
});


describe('SCIM pagination limits', () => {
  const users = Array.from({ length: 201 }, (_, id) => ({ id }));
  test('caps the first page at 200 and preserves the directory total', () => {
    const page = listResponse(users, { count: 1000 });
    expect(page.totalResults).toBe(201);
    expect(page.itemsPerPage).toBe(200);
    expect(page.Resources.at(-1)).toEqual({ id: 199 });
    expect(listResponse(users, { startIndex: 201 }).Resources).toEqual([{ id: 200 }]);
  });
  test('supports a zero count and offsets beyond the directory', () => {
    expect(listResponse(users, { count: 0 }).Resources).toEqual([]);
    expect(listResponse(users, { startIndex: 202 }).Resources).toEqual([]);
    expect(listResponse(users, { startIndex: 0, count: 1 }).startIndex).toBe(1);
  });
});
