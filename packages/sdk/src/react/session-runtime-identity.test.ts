import { expect, test } from 'bun:test';

import {
  hasSessionRuntimeIdentity,
  isSessionRuntimeActionReady,
} from './session-runtime-identity';

test('managed ACP does not require an OpenCode session id', () => {
  expect(hasSessionRuntimeIdentity({ usesAcp: true, opencodeSessionId: null })).toBe(true);
});

test('REST requires an OpenCode session id', () => {
  expect(hasSessionRuntimeIdentity({ usesAcp: false, opencodeSessionId: null })).toBe(false);
  expect(hasSessionRuntimeIdentity({ usesAcp: false, opencodeSessionId: 'ses_1' })).toBe(true);
});

test('a preassigned OpenCode id cannot authorize runtime actions before the sandbox switch', () => {
  expect(
    isSessionRuntimeActionReady({
      switched: false,
      usesAcp: false,
      opencodeSessionId: 'ses_cached',
    }),
  ).toBe(false);
  expect(
    isSessionRuntimeActionReady({
      switched: true,
      usesAcp: false,
      opencodeSessionId: 'ses_authoritative',
    }),
  ).toBe(true);
});
