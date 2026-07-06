import { expect, test } from 'bun:test';

import { isRuntimeNotReadyError } from './error';

test('matches the existing sandbox/opencode boot-race messages', () => {
  expect(isRuntimeNotReadyError(new Error('Server URL not ready — sandbox is still loading'))).toBe(true);
  expect(isRuntimeNotReadyError(new Error('opencode not ready'))).toBe(true);
});

// Regression: the SDK's per-session runtime errors weren't recognized as
// transient boot races, so they fell through to the hard crash screen instead
// of the "Starting your session…" loader.
test('matches SessionNotReadyError\'s message', () => {
  expect(
    isRuntimeNotReadyError(
      new Error(
        'Session runtime not ready — call `await session.ensureReady()` before calling `health`.',
      ),
    ),
  ).toBe(true);
});

test('matches the "no auth token provider configured" message', () => {
  expect(
    isRuntimeNotReadyError(
      new Error(
        '[opencode-sdk] No auth token provider configured — call configureKortix()/createKortix() before talking to a sandbox runtime.',
      ),
    ),
  ).toBe(true);
});

test('does not match an unrelated error', () => {
  expect(isRuntimeNotReadyError(new Error('Something else went wrong'))).toBe(false);
});
