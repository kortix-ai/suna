import { describe, expect, test } from 'bun:test';

import { shouldRunOnboarding } from './onboarding-gate';

/**
 * `shouldRunOnboarding` is the ONLY place the "first project in an account"
 * threshold is decided. Every other test in this feature (`use-create-workspace.
 * test.ts`) trusts this boundary rather than re-deriving it, so it earns its
 * own dedicated coverage at exactly 0 and exactly 1 — the two values either
 * side of the line — plus a value well past it so a future "< 1" -> "=== 0"
 * typo (which would still pass at 0 and 1) cannot slip through unnoticed.
 */
describe('shouldRunOnboarding', () => {
  test('runs for an account with zero existing projects — this create is the first', () => {
    expect(shouldRunOnboarding({ existingProjectCount: 0 })).toBe(true);
  });

  test('does NOT run once the account already has exactly one project', () => {
    expect(shouldRunOnboarding({ existingProjectCount: 1 })).toBe(false);
  });

  test('does NOT run for an account with many existing projects', () => {
    expect(shouldRunOnboarding({ existingProjectCount: 5 })).toBe(false);
  });
});
