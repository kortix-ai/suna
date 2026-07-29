import { describe, expect, test } from 'bun:test';

import { resolveSessionBusy } from './session-busy';

describe('resolveSessionBusy', () => {
  test('includes ACP prompt submission before the first busy update', () => {
    expect(
      resolveSessionBusy({
        syncBusy: false,
        hasPendingText: false,
        usesAcp: true,
        acpSending: true,
      }),
    ).toBe(true);
  });

  test('does not apply ACP sending state to the REST rollback path', () => {
    expect(
      resolveSessionBusy({
        syncBusy: false,
        hasPendingText: false,
        usesAcp: false,
        acpSending: true,
      }),
    ).toBe(false);
  });
});
