import { afterEach, describe, expect, test } from 'bun:test';

import {
  PROJECT_LANDING_PATH,
  isValidProjectId,
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
  test('sends a remembered project straight to its page', () => {
    expect(resolveDefaultLandingPath(VALID)).toBe(`/projects/${VALID}`);
  });

  test('falls back to the landing door, never to the projects list', () => {
    // The regression this guards: the default destination silently reverting to
    // the `/projects` list, which is the manual-selection step we removed.
    expect(resolveDefaultLandingPath(null)).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath('nonsense')).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath(PROJECT_LANDING_PATH)).toBe(PROJECT_LANDING_PATH);
  });

  test('a tampered cookie can never produce an off-origin redirect', () => {
    for (const hostile of [
      'https://evil.example.com',
      '//evil.example.com',
      '/admin',
      '../admin',
    ]) {
      expect(resolveDefaultLandingPath(hostile)).toBe(PROJECT_LANDING_PATH);
    }
  });
});

describe('navigationMayCreateProject (CWE-352 gate)', () => {
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
    const { navigationMayCreateProject } = await import('./ensure-first-project');
    withNavigation(`${origin}/auth/callback?auth_event=signup`);
    expect(navigationMayCreateProject()).toBe(true);
  });

  test('allows creation for a typed or bookmarked navigation (no referrer)', async () => {
    const { navigationMayCreateProject } = await import('./ensure-first-project');
    withNavigation('');
    expect(navigationMayCreateProject()).toBe(true);
  });

  test('refuses creation when the referrer is another origin', async () => {
    // The finding: a signed-in user following a cross-site link must not mint a
    // managed git repo just by loading the page.
    const { navigationMayCreateProject } = await import('./ensure-first-project');
    for (const hostile of [
      'https://evil.example.com/bait',
      'http://app.kortix.com/',
      'https://app.kortix.com.evil.example.com/',
    ]) {
      withNavigation(hostile);
      expect({ hostile, allowed: navigationMayCreateProject() }).toEqual({
        hostile,
        allowed: false,
      });
    }
  });

  test('refuses creation for an unparseable referrer', async () => {
    const { navigationMayCreateProject } = await import('./ensure-first-project');
    withNavigation('not a url');
    expect(navigationMayCreateProject()).toBe(false);
  });
});
