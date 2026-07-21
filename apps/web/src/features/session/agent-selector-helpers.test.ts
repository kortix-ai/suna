import { describe, expect, test } from 'bun:test';

import { isHarnessDisconnected } from './agent-selector-helpers';

describe('isHarnessDisconnected', () => {
  test('a ready runtime is connected — no dot', () => {
    expect(isHarnessDisconnected('ready')).toBe(false);
  });

  test('a checking runtime is still resolving — no dot yet', () => {
    expect(isHarnessDisconnected('checking')).toBe(false);
  });

  test('missing, ambiguous, needs-attention, and unavailable all count as not connected', () => {
    expect(isHarnessDisconnected('missing')).toBe(true);
    expect(isHarnessDisconnected('ambiguous')).toBe(true);
    expect(isHarnessDisconnected('needs-attention')).toBe(true);
    expect(isHarnessDisconnected('unavailable')).toBe(true);
  });

  test('no runtime entry for the harness (status unknown) never shows a dot', () => {
    expect(isHarnessDisconnected(undefined)).toBe(false);
  });
});
