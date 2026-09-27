import { describe, expect, test } from 'bun:test';

import { SPLASH_SAFETY_TIMEOUT_MS, shouldHideSplash, type SplashGateInput } from './splash-gate';

const settledProject: SplashGateInput = {
  splashHidden: false,
  timedOut: false,
  fontsReady: true,
  authLoading: false,
  authenticated: true,
  segment: 'projects',
  landingSettled: false,
};

describe('shouldHideSplash', () => {
  test('the safety timeout is 10 s', () => {
    expect(SPLASH_SAFETY_TIMEOUT_MS).toBe(10_000);
  });

  test('a start route that resolved (fonts + auth + landed) hides the splash', () => {
    expect(shouldHideSplash(settledProject)).toBe(true);
    expect(shouldHideSplash({ ...settledProject, segment: 'auth' })).toBe(true);
    expect(shouldHideSplash({ ...settledProject, segment: 'new' })).toBe(true);
  });

  test('fonts still loading keeps the splash', () => {
    expect(shouldHideSplash({ ...settledProject, fontsReady: false })).toBe(false);
  });

  test('auth still loading keeps the splash, on any route', () => {
    expect(shouldHideSplash({ ...settledProject, authLoading: true })).toBe(false);
    expect(shouldHideSplash({ ...settledProject, segment: 'auth', authLoading: true })).toBe(false);
  });

  test('the start screen keeps the splash until it settles (redirect or failure copy)', () => {
    const onStart = { ...settledProject, segment: undefined };
    expect(shouldHideSplash(onStart)).toBe(false);
    expect(shouldHideSplash({ ...onStart, landingSettled: true })).toBe(true);
  });

  test('the upgrade screen and not-found keep the splash until the landing settles', () => {
    expect(shouldHideSplash({ ...settledProject, segment: 'welcome' })).toBe(false);
    expect(shouldHideSplash({ ...settledProject, segment: 'welcome', landingSettled: true })).toBe(true);
    expect(shouldHideSplash({ ...settledProject, segment: '+not-found' })).toBe(false);
  });

  test('the safety timeout hides the splash whatever is still loading', () => {
    expect(
      shouldHideSplash({
        splashHidden: false,
        timedOut: true,
        fontsReady: false,
        authLoading: true,
        authenticated: false,
        segment: undefined,
        landingSettled: false,
      })
    ).toBe(true);
  });

  test('signed out, only the auth screen is a landing: a protected deep link waits for the redirect', () => {
    const signedOut = { ...settledProject, authenticated: false };
    expect(shouldHideSplash(signedOut)).toBe(false);
    expect(shouldHideSplash({ ...signedOut, segment: 'new' })).toBe(false);
    expect(shouldHideSplash({ ...signedOut, segment: undefined, landingSettled: true })).toBe(false);
    expect(shouldHideSplash({ ...signedOut, segment: 'auth' })).toBe(true);
    expect(shouldHideSplash({ ...signedOut, timedOut: true })).toBe(true);
  });

  test('a hidden splash is never hidden twice', () => {
    expect(shouldHideSplash({ ...settledProject, splashHidden: true })).toBe(false);
    expect(shouldHideSplash({ ...settledProject, splashHidden: true, timedOut: true })).toBe(false);
  });
});
