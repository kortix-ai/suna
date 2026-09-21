import { describe, expect, test } from 'bun:test';

import {
  PROJECT_LANDING_PATH,
  isValidProjectId,
  parseAuthBounceOwner,
  parseLastProjectOwner,
  projectPathFromId,
  resolveDefaultLandingPath,
} from './landing-destination';

const VALID = '11111111-1111-4111-8111-111111111111';

describe('isValidProjectId', () => {
  test('accepts a UUID in either case', () => {
    expect(isValidProjectId(VALID)).toBe(true);
    expect(isValidProjectId(VALID.toUpperCase())).toBe(true);
  });

  test('rejects everything that is not a UUID', () => {
    for (const value of [
      null,
      undefined,
      '',
      'start',
      `${VALID} `,
      `${VALID}/../../admin`,
      '../../etc/passwd',
      'https://evil.example.com',
      '//evil.example.com',
      `${VALID}?next=/admin`,
      '1111111-1111-4111-8111-111111111111',
    ]) {
      expect(isValidProjectId(value as string | null | undefined)).toBe(false);
    }
  });
});

describe('projectPathFromId', () => {
  test('builds the project path for a valid id', () => {
    expect(projectPathFromId(VALID)).toBe(`/projects/${VALID}`);
  });

  test('returns null rather than a path for untrusted input', () => {
    expect(projectPathFromId('//evil.example.com')).toBeNull();
    expect(projectPathFromId(null)).toBeNull();
  });
});

describe('resolveDefaultLandingPath', () => {
  const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const cookie = (userId: string, projectId: string) => `${userId}:${projectId}`;

  test('sends a remembered project straight to its page for its OWNER', () => {
    expect(resolveDefaultLandingPath(cookie(USER_A, VALID), USER_A)).toBe(`/projects/${VALID}`);
  });

  test("REGRESSION: a different user never inherits the previous account's project", () => {
    // The shipped bug: sign out of A, sign in as B in the same browser, and the
    // post-auth redirect followed A's cookie straight into A's project — so B
    // landed on "Request access to this project" on every single login.
    expect(resolveDefaultLandingPath(cookie(USER_A, VALID), USER_B)).toBe(PROJECT_LANDING_PATH);
  });

  test('a legacy unowned cookie (bare project id) is never trusted', () => {
    // Cookies written before the binding existed carry no owner, so they could
    // belong to anyone who used this browser.
    expect(resolveDefaultLandingPath(VALID, USER_A)).toBe(PROJECT_LANDING_PATH);
  });

  test('falls back to the landing door, never to the projects list', () => {
    expect(resolveDefaultLandingPath(null, USER_A)).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath('nonsense', USER_A)).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath(cookie(USER_A, VALID), null)).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath(cookie(USER_A, 'not-a-uuid'), USER_A)).toBe(
      PROJECT_LANDING_PATH,
    );
  });

  test('a tampered cookie can never produce an off-origin redirect', () => {
    for (const hostile of [
      'https://evil.example.com',
      '//evil.example.com',
      '/admin',
      '../admin',
      `${USER_A}://evil.example.com`,
      `${USER_A}:../../admin`,
    ]) {
      expect(resolveDefaultLandingPath(hostile, USER_A)).toBe(PROJECT_LANDING_PATH);
    }
  });
});

describe('parseAuthBounceOwner and parseLastProjectOwner must agree', () => {
  // Byte-identical bodies today (both delegate to the same
  // `ownerIdFromCookie`) kept as two exported names because
  // `AUTH_BOUNCE_COOKIE` and `LAST_PROJECT_COOKIE` answer different
  // questions — see `parseLastProjectOwner`'s own doc comment. This is the
  // anti-drift guard that comment promises: a future edit to one function's
  // owner-parsing rule that is not mirrored to the other fails HERE, on the
  // next input either one is exercised with, instead of drifting silently
  // until a bounce or a landing resolution disagrees about who owns a
  // cookie.
  test('return the SAME owner for the same cookie value, across real and edge-case inputs', () => {
    for (const cookieValue of [
      undefined,
      null,
      '',
      'not-a-cookie',
      `${VALID}:/projects/abc`,
      `${VALID}:${encodeURIComponent('/projects/abc?x=1')}`,
      'bare-legacy-value-no-colon',
      ':missing-owner',
      `${VALID}:`,
    ]) {
      expect({ cookieValue, result: parseLastProjectOwner(cookieValue) }).toEqual({
        cookieValue,
        result: parseAuthBounceOwner(cookieValue),
      });
    }
  });
});
