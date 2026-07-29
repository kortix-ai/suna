import { describe, expect, test } from 'bun:test';
import { shouldLoadOlderHistory } from './session-older-autoload';

const IN_VIEW = {
  isIntersecting: true,
  hasOlder: true,
  isLoadingOlder: false,
  lastPullFailed: false,
};

describe('older-history autoload', () => {
  test('pulls the previous page once the top sentinel comes into view', () => {
    expect(shouldLoadOlderHistory(IN_VIEW)).toBe(true);
  });

  test('does not pull while the sentinel is out of view', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, isIntersecting: false })).toBe(false);
  });

  test('does not pull at the start of history', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, hasOlder: false })).toBe(false);
  });

  test('does not pull a second page while the first is in flight', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, isLoadingOlder: true })).toBe(false);
  });

  // Without this the observer re-arms on every state change and a failing
  // cursor turns into an unbounded request loop against the runtime — the
  // failure mode the manual button structurally could not have.
  test('stops auto-pulling after a failed pull, until an explicit retry', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, lastPullFailed: true })).toBe(false);
  });
});
