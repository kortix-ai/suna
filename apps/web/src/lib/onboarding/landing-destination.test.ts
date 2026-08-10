import { afterEach, describe, expect, test } from 'bun:test';

import {
  WORKSPACE_LANDING_PATH,
  isValidWorkspaceId,
  workspacePathFromId,
  resolveDefaultLandingPath,
} from './landing-destination';

const VALID = '11111111-1111-4111-8111-111111111111';

describe('isValidWorkspaceId', () => {
  test('accepts a UUID in either case', () => {
    expect(isValidWorkspaceId(VALID)).toBe(true);
    expect(isValidWorkspaceId(VALID.toUpperCase())).toBe(true);
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
      expect(isValidWorkspaceId(value as string | null | undefined)).toBe(false);
    }
  });
});

describe('workspacePathFromId', () => {
  test('builds the canonical Workspace path for a valid id', () => {
    expect(workspacePathFromId(VALID)).toBe(`/workspaces/${VALID}`);
  });

  test('returns null rather than a path for untrusted input', () => {
    expect(workspacePathFromId('//evil.example.com')).toBeNull();
    expect(workspacePathFromId(null)).toBeNull();
  });
});

describe('resolveDefaultLandingPath', () => {
  const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const cookie = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

  test('sends a remembered project straight to its page for its OWNER', () => {
    expect(resolveDefaultLandingPath(cookie(USER_A, VALID), USER_A)).toBe(`/workspaces/${VALID}`);
  });

  test("REGRESSION: a different user never inherits the previous account's project", () => {
    // The shipped bug: sign out of A, sign in as B in the same browser, and the
    // post-auth redirect followed A's cookie straight into A's project — so B
    // landed on "Request access to this workspace" on every single login.
    expect(resolveDefaultLandingPath(cookie(USER_A, VALID), USER_B)).toBe(WORKSPACE_LANDING_PATH);
  });

  test('a legacy unowned cookie (bare workspace id) is never trusted', () => {
    // Cookies written before the binding existed carry no owner, so they could
    // belong to anyone who used this browser.
    expect(resolveDefaultLandingPath(VALID, USER_A)).toBe(WORKSPACE_LANDING_PATH);
  });

  test('falls back to the landing door, never to the workspaces list', () => {
    expect(resolveDefaultLandingPath(null, USER_A)).toBe(WORKSPACE_LANDING_PATH);
    expect(resolveDefaultLandingPath('nonsense', USER_A)).toBe(WORKSPACE_LANDING_PATH);
    expect(resolveDefaultLandingPath(cookie(USER_A, VALID), null)).toBe(WORKSPACE_LANDING_PATH);
    expect(resolveDefaultLandingPath(cookie(USER_A, 'not-a-uuid'), USER_A)).toBe(
      WORKSPACE_LANDING_PATH,
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
      expect(resolveDefaultLandingPath(hostile, USER_A)).toBe(WORKSPACE_LANDING_PATH);
    }
  });
});

describe('navigationMayCreateWorkspace (CWE-352 gate)', () => {
  const origin = 'https://app.kortix.com';

  // Save/restore the real globals. Bun runs many test FILES in one process, so
  // leaving a stub `document`/`window` behind here breaks every DOM-touching
  // suite that happens to run after this one.
  const hadDocument = 'document' in globalThis;
  const hadWindow = 'window' in globalThis;
  const realDocument = (globalThis as { document?: unknown }).document;
  const realWindow = (globalThis as { window?: unknown }).window;

  function withNavigation(referrer: string) {
    (globalThis as { document?: unknown }).document = { referrer };
    (globalThis as { window?: unknown }).window = { location: { origin } };
  }

  afterEach(() => {
    if (hadDocument) (globalThis as { document?: unknown }).document = realDocument;
    else delete (globalThis as { document?: unknown }).document;
    if (hadWindow) (globalThis as { window?: unknown }).window = realWindow;
    else delete (globalThis as { window?: unknown }).window;
  });

  test('allows creation for a same-origin navigation', async () => {
    const { navigationMayCreateWorkspace } = await import('./ensure-first-workspace');
    withNavigation(`${origin}/auth/callback?auth_event=signup`);
    expect(navigationMayCreateWorkspace()).toBe(true);
  });

  test('allows creation for a typed or bookmarked navigation (no referrer)', async () => {
    const { navigationMayCreateWorkspace } = await import('./ensure-first-workspace');
    withNavigation('');
    expect(navigationMayCreateWorkspace()).toBe(true);
  });

  test('refuses creation when the referrer is another origin', async () => {
    // The finding: a signed-in user following a cross-site link must not mint a
    // managed git repo just by loading the page.
    const { navigationMayCreateWorkspace } = await import('./ensure-first-workspace');
    for (const hostile of [
      'https://evil.example.com/bait',
      'http://app.kortix.com/',
      'https://app.kortix.com.evil.example.com/',
    ]) {
      withNavigation(hostile);
      expect({ hostile, allowed: navigationMayCreateWorkspace() }).toEqual({
        hostile,
        allowed: false,
      });
    }
  });

  test('refuses creation for an unparseable referrer', async () => {
    const { navigationMayCreateWorkspace } = await import('./ensure-first-workspace');
    withNavigation('not a url');
    expect(navigationMayCreateWorkspace()).toBe(false);
  });
});
