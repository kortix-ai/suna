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

/**
 * Deprovisioning through SCIM must release the paid seat.
 *
 * Removing the member row is not the whole offboarding: on a per-seat account
 * the Stripe subscription QUANTITY is what gets invoiced, and only
 * `onMemberRemoved` lowers it. The UI removal path has always called it
 * (accounts/core/members.ts:549, :704). SCIM never did — so an enterprise
 * offboarding through its IdP, the automated channel we tell enterprises to
 * use, kept paying for every departed employee indefinitely. Nothing reconciles
 * seats periodically, so it never self-healed.
 *
 * Asserted against the source: `deprovisionMember` is module-private, its two
 * collaborators are a DB delete and a Stripe round-trip, and the property that
 * matters is simply that the call is on the path at all.
 */
import { readFileSync as readScimSource } from 'node:fs';
import { join as joinScimPath } from 'node:path';

const SCIM_USERS_SRC = readScimSource(
  joinScimPath(import.meta.dir, '..', 'scim', 'users.ts'),
  'utf8',
);

describe('SCIM deprovision releases the seat', () => {
  function deprovisionBody(): string {
    const body = SCIM_USERS_SRC.split('async function deprovisionMember(')[1]?.split('\n}\n')[0];
    expect(body).toBeTruthy();
    // Guard the extraction: if this stops covering the identity-row delete, every
    // assertion below passes vacuously.
    expect(body).toContain('delete(accountMemberships)');
    return body as string;
  }

  test('onMemberRemoved is called on the deprovision path', () => {
    expect(deprovisionBody()).toContain('onMemberRemoved(accountId, userId)');
  });

  test('it is awaited, so the seat release cannot race the SCIM reply', () => {
    expect(deprovisionBody()).toContain('await onMemberRemoved(');
  });

  test('the seat release happens after the member row is gone', () => {
    // Ordering matters: syncSeatQuantity counts remaining members, so releasing
    // before the delete would recount the leaving member and change nothing.
    const body = deprovisionBody();
    expect(body.indexOf('delete(accountMemberships)')).toBeLessThan(body.indexOf('onMemberRemoved('));
  });

  test('the module actually imports it', () => {
    expect(SCIM_USERS_SRC).toContain("from '../billing/services/seat-management'");
  });
});
