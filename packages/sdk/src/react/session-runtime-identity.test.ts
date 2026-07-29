import { expect, test } from 'bun:test';

import { hasSessionRuntimeIdentity } from './session-runtime-identity';

test('managed ACP does not require an OpenCode session id', () => {
  expect(hasSessionRuntimeIdentity({ usesAcp: true, opencodeSessionId: null })).toBe(true);
});

test('REST requires an OpenCode session id', () => {
  expect(hasSessionRuntimeIdentity({ usesAcp: false, opencodeSessionId: null })).toBe(false);
  expect(hasSessionRuntimeIdentity({ usesAcp: false, opencodeSessionId: 'ses_1' })).toBe(true);
});
