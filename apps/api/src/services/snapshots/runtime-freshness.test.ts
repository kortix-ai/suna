import { describe, expect, test } from 'bun:test';

import { canServeLastKnownGoodRuntime } from './runtime-freshness';

describe('canServeLastKnownGoodRuntime', () => {
  test('keeps the non-blocking path for session starts', () => {
    expect(
      canServeLastKnownGoodRuntime({
        source: 'session-start',
      }),
    ).toBe(true);
  });

  test('never serves a stale runtime for explicit build operations', () => {
    for (const source of ['project-create', 'cr-merge', 'manual', 'background', 'startup'] as const) {
      expect(
        canServeLastKnownGoodRuntime({
          source,
        }),
      ).toBe(false);
    }
  });
});
