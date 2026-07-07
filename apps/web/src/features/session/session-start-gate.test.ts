import { expect, test } from 'bun:test';
import { shouldShowStartError } from './session-start-gate';

test('hides a start error while the session is still fresh (boot noise)', () => {
  expect(shouldShowStartError({ status: 404 }, true)).toBe(false);
});

test('shows a start error once the session is no longer fresh', () => {
  expect(shouldShowStartError({ status: 404 }, false)).toBe(true);
});

test('no error → nothing to show', () => {
  expect(shouldShowStartError(null, false)).toBe(false);
  expect(shouldShowStartError(null, true)).toBe(false);
});
