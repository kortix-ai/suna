import { describe, expect, test } from 'bun:test';

import { isUnmaterializedSessionFailure } from './session-terminal-state';

describe('isUnmaterializedSessionFailure', () => {
  test('detects a terminal start result with no sandbox payload', () => {
    expect(
      isUnmaterializedSessionFailure({
        phase: 'error',
        hasStartError: false,
        sandboxStatus: null,
      }),
    ).toBe(true);
  });

  test('does not replace a typed start error', () => {
    expect(
      isUnmaterializedSessionFailure({
        phase: 'error',
        hasStartError: true,
        sandboxStatus: null,
      }),
    ).toBe(false);
  });

  test('defers sandbox terminal states to their detailed error card', () => {
    for (const sandboxStatus of ['error', 'stopped']) {
      expect(
        isUnmaterializedSessionFailure({
          phase: 'error',
          hasStartError: false,
          sandboxStatus,
        }),
      ).toBe(false);
    }
  });

  test('does not classify an active boot as terminal', () => {
    expect(
      isUnmaterializedSessionFailure({
        phase: 'starting',
        hasStartError: false,
        sandboxStatus: null,
      }),
    ).toBe(false);
  });
});
