import { describe, expect, test } from 'bun:test';
import { resolveEffectiveBusy } from './session-chat-busy';

describe('resolveEffectiveBusy', () => {
  test('a server-busy session is busy', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: true,
        isOptimisticCompacting: false,
        hasRetryingAssistant: false,
      }),
    ).toBe(true);
  });

  test('an optimistically compacting session is busy', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: false,
        isOptimisticCompacting: true,
        hasRetryingAssistant: false,
      }),
    ).toBe(true);
  });

  // S7: a turn mid provider-retry is LIVE. The projection can read idle for it
  // (the runtime's last status frame is stale by construction during a backoff),
  // so the retrying-turn predicate has to be able to answer on its own.
  test('a turn mid provider-retry is busy even when the projection says idle', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: false,
        isOptimisticCompacting: false,
        hasRetryingAssistant: true,
      }),
    ).toBe(true);
  });

  test('an idle session with no retrying turn is not busy', () => {
    expect(
      resolveEffectiveBusy({
        isServerBusy: false,
        isOptimisticCompacting: false,
        hasRetryingAssistant: false,
      }),
    ).toBe(false);
  });
});
