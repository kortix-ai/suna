import { describe, expect, test } from 'bun:test';
import { promoteAndKickNextInboxRow } from './settled-drain-kick';
import { INBOX_TURN_SETTLE_MS } from './store';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDrain() {
  const calls: { idempotencyKey: string }[] = [];
  return {
    calls,
    drain: async (input: { idempotencyKey: string }) => {
      calls.push(input);
      return {};
    },
  };
}

describe('promoteAndKickNextInboxRow', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * `promoteNextInboxRow` makes the row due `INBOX_TURN_SETTLE_MS` from now,
   * and `drainSessionLifecycleQueue` claims by `idempotencyKey` AND
   * `availableAt <= now`. Drop the delay and the kick fires inside the settle
   * window, claims ZERO rows, and — because nothing re-kicks one specific row
   * — the prompt silently falls back to the scheduler's untargeted ~1s drain.
   * Real timers on purpose: a fake scheduler cannot tell "deferred" from
   * "called in the same tick with a delay argument nobody honours".
   */
  test('does not kick the drain inside the settle window, and kicks it after', async () => {
    const { calls, drain } = fakeDrain();
    const promoted = await promoteAndKickNextInboxRow('s-1', {
      promote: async () => 'prompt-1',
      drain,
    });
    expect(promoted).toBe('prompt-1');
    // Same tick as the promotion: the row is not claimable yet.
    expect(calls).toEqual([]);
    // Still inside the window.
    await sleep(Math.floor(INBOX_TURN_SETTLE_MS / 2));
    expect(calls).toEqual([]);
    // Past it: the targeted kick lands, naming exactly the promoted row.
    await sleep(INBOX_TURN_SETTLE_MS);
    expect(calls).toEqual([{ idempotencyKey: 'prompt-1' }]);
  });

  test('schedules the kick exactly INBOX_TURN_SETTLE_MS out, never sooner', async () => {
    const { calls, drain } = fakeDrain();
    const scheduled: { fn: () => void; ms: number }[] = [];
    await promoteAndKickNextInboxRow('s-1', {
      promote: async () => 'prompt-2',
      drain,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return 0;
      },
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(INBOX_TURN_SETTLE_MS);
    expect(calls).toEqual([]);
    scheduled[0]!.fn();
    await sleep(0);
    expect(calls).toEqual([{ idempotencyKey: 'prompt-2' }]);
  });

  test('promotes nothing -> kicks nothing', async () => {
    const { calls, drain } = fakeDrain();
    const scheduled: number[] = [];
    const promoted = await promoteAndKickNextInboxRow('s-1', {
      promote: async () => null,
      drain,
      schedule: (_fn, ms) => {
        scheduled.push(ms);
        return 0;
      },
    });
    expect(promoted).toBeNull();
    expect(scheduled).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a rejected drain reaches onError and never escapes as an unhandled rejection', async () => {
    const seen: { error: unknown; key: string }[] = [];
    const scheduled: (() => void)[] = [];
    await promoteAndKickNextInboxRow('s-1', {
      promote: async () => 'prompt-3',
      drain: async () => {
        throw new Error('drain exploded');
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return 0;
      },
      onError: (error, key) => {
        seen.push({ error, key });
      },
    });
    scheduled[0]!();
    await sleep(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe('prompt-3');
    expect((seen[0]!.error as Error).message).toBe('drain exploded');
  });

  test('a rejected drain with no onError is swallowed, not thrown', async () => {
    const scheduled: (() => void)[] = [];
    await promoteAndKickNextInboxRow('s-1', {
      promote: async () => 'prompt-4',
      drain: async () => {
        throw new Error('drain exploded');
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return 0;
      },
    });
    expect(() => scheduled[0]!()).not.toThrow();
    await sleep(0);
  });
});
