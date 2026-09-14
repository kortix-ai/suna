import { describe, expect, test } from 'bun:test';

import {
  parseAuthBounceOwner,
  parseLastProjectOwner,
  serializeAuthBounce,
} from '@/lib/onboarding/landing-destination';
import { shouldDemoteReturnUrl } from './return-url';

/**
 * The decision behind the middleware bounce cookie.
 *
 * Two rules meet here and they pull in opposite directions:
 *  - fail CLOSED on identity — a return URL bounced from a named session must
 *    not be replayed for a different account;
 *  - fail OPEN on absence — a bounce that names nobody, and a pasted or
 *    bookmarked `/auth?redirect=…` link with no cookie at all, must keep
 *    working. "Unknown" is not "foreign".
 *
 * Collapsing either into the other breaks a real flow, so both are pinned.
 */

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('shouldDemoteReturnUrl', () => {
  test('demotes when the bounce names someone other than the signer', () => {
    // The reported bug, reduced: A was bounced, B signed in.
    expect(
      shouldDemoteReturnUrl({
        bouncedOwnerId: USER_A,
        signedInUserId: USER_B,
        isNewUser: false,
      }),
    ).toBe(true);
  });

  test('keeps the path when the signer IS the bounced user', () => {
    // A session that expired and came straight back. This is the single-account
    // happy path and must be untouched.
    expect(
      shouldDemoteReturnUrl({
        bouncedOwnerId: USER_A,
        signedInUserId: USER_A,
        isNewUser: false,
      }),
    ).toBe(false);
  });

  test('an UNATTRIBUTED bounce does not demote', () => {
    // Middleware cannot always name an owner: the stale-session self-heal may
    // have nulled the user before the bounce is built, and nothing may remember
    // a project. Demoting on that would break every one of those returns.
    for (const bouncedOwnerId of ['', null, undefined]) {
      expect(
        shouldDemoteReturnUrl({ bouncedOwnerId, signedInUserId: USER_B, isNewUser: false }),
      ).toBe(false);
    }
  });

  test('a signup always demotes, attributed or not', () => {
    // The rule that already shipped. A seconds-old account cannot own anything
    // that predates it, whoever was bounced.
    expect(shouldDemoteReturnUrl({ isNewUser: true })).toBe(true);
    expect(
      shouldDemoteReturnUrl({ bouncedOwnerId: USER_A, signedInUserId: USER_A, isNewUser: true }),
    ).toBe(true);
  });

  test('an attributed bounce with no known signer demotes — fail closed', () => {
    // The link-mint case: `sendEmailCode` bakes the return path into an email
    // before any identity exists, and that link can be opened on a device that
    // never held the bounced session. There is nothing to compare against, so
    // the path does not travel.
    expect(shouldDemoteReturnUrl({ bouncedOwnerId: USER_A, signedInUserId: null })).toBe(true);
    expect(shouldDemoteReturnUrl({ bouncedOwnerId: USER_A, signedInUserId: '' })).toBe(true);
  });
});

describe('bounce cookie format', () => {
  test('round-trips the owner', () => {
    expect(parseAuthBounceOwner(serializeAuthBounce(USER_A, '/projects/x'))).toBe(USER_A);
  });

  test('an absent owner serializes to an empty owner half, not to nothing', () => {
    const value = serializeAuthBounce(null, '/projects/x');

    expect(value.startsWith(':')).toBe(true);
    expect(parseAuthBounceOwner(value)).toBe('');
  });

  test('the cookie is browser-written, so a non-user-id owner is discarded', () => {
    // Anything but a well-formed id attributes nobody. The worst a tampered
    // cookie can do is send its own browser to the landing door.
    expect(parseAuthBounceOwner('../../etc:%2Fx')).toBe('');
    expect(parseAuthBounceOwner('no-separator')).toBe('');
    expect(parseAuthBounceOwner(undefined)).toBe('');
    expect(parseAuthBounceOwner('')).toBe('');
  });

  test('the path half never carries a character a cookie cannot', () => {
    const value = serializeAuthBounce(USER_A, '/projects/x?a=1,2;b=3 4');

    expect(/[,; ]/.test(value)).toBe(false);
    expect(decodeURIComponent(value.slice(value.indexOf(':') + 1))).toBe('/projects/x?a=1,2;b=3 4');
  });
});

describe('parseLastProjectOwner (the middleware fallback)', () => {
  test('reads the owner half of the remembered project', () => {
    expect(parseLastProjectOwner(`${USER_A}:319395c1-9c3f-41b4-ac6c-9539a12dbb7c`)).toBe(USER_A);
  });

  test('a legacy bare project id names no owner', () => {
    expect(parseLastProjectOwner('319395c1-9c3f-41b4-ac6c-9539a12dbb7c')).toBe('');
  });
});
