import { describe, expect, test } from 'bun:test';

import { canServeLastKnownGoodRuntime } from './runtime-freshness';

describe('canServeLastKnownGoodRuntime', () => {
  test('rejects a stale runtime for ACP sessions', () => {
    expect(
      canServeLastKnownGoodRuntime({
        source: 'session-start',
        requireCurrentRuntime: true,
      }),
    ).toBe(false);
  });

  test('keeps the non-blocking compatibility path for REST sessions', () => {
    expect(
      canServeLastKnownGoodRuntime({
        source: 'session-start',
        requireCurrentRuntime: false,
      }),
    ).toBe(true);
  });

  test('never serves a stale runtime for explicit build operations', () => {
    for (const source of ['project-create', 'cr-merge', 'manual', 'background', 'startup'] as const) {
      expect(
        canServeLastKnownGoodRuntime({
          source,
          requireCurrentRuntime: false,
        }),
      ).toBe(false);
    }
  });
});
