import { describe, expect, test } from 'bun:test';
import { reconcileRuntimeWakeCandidate } from './runtime-wake-maintenance';

describe('reconcileRuntimeWakeCandidate', () => {
  test('stops a provider VM that started after its wake claim failed', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => {
        events.push('claim');
        return true;
      },
      getStatus: async () => 'running',
      stop: async () => {
        events.push('stop');
      },
      markChecked: async () => {
        events.push('check');
      },
      markStopped: async () => {
        events.push('record-stop');
      },
      markRemoved: async () => {
        events.push('preserve-unavailable');
      },
    });

    expect(result).toBe('stopped');
    expect(events).toEqual(['claim', 'stop', 'record-stop']);
  });

  test('keeps checking a non-running ambiguous start without issuing stop', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => {
        events.push('claim');
        return true;
      },
      getStatus: async () => 'stopped',
      stop: async () => {
        events.push('stop');
      },
      markChecked: async (status) => {
        events.push(`check:${status}`);
      },
      markStopped: async () => {
        events.push('record-stop');
      },
      markRemoved: async () => {
        events.push('preserve-unavailable');
      },
    });

    expect(result).toBe('checked');
    expect(events).toEqual(['claim', 'check:stopped']);
  });

  // Regression for prod session ad4b63ac (2026-08-13). Its Platinum box was
  // parked on 08-12, then vanished provider-side. The user's wake failed at
  // 13:51:48; this pass asked Platinum at 14:03:50 and got a definitive
  // `removed` — and recorded it as `runtimeWakeLateStartProviderStatus` and
  // did NOTHING else. The row stayed `stopped` + resumable, so the session kept
  // offering "Restart session", and the identity was not preserved until the
  // user opened the session again at 15:40:14 — 1h36m after the platform could
  // prove the runtime was gone, and only because a human happened to look.
  //
  // Nothing else covers this: the box reaper's candidate predicate is
  // `status = 'active'` (reaping/box-queries.ts), so it never examines a parked
  // row. This pass is the ONLY component that asks the provider about a stopped
  // sandbox, which makes discarding its answer a dead end by construction.
  test('preserves the identity when the provider proves a parked runtime is gone', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => {
        events.push('claim');
        return true;
      },
      getStatus: async () => 'removed',
      stop: async () => {
        events.push('stop');
      },
      markChecked: async (status) => {
        events.push(`check:${status}`);
      },
      markStopped: async () => {
        events.push('record-stop');
      },
      markRemoved: async () => {
        events.push('preserve-unavailable');
      },
    });

    expect(result).toBe('removed');
    // No provider stop: the box is already gone, and the identity is preserved
    // rather than re-checked into another silent pass.
    expect(events).toEqual(['claim', 'preserve-unavailable']);
  });

  test('a transient `unknown` is still only recorded, never preserved as gone', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => true,
      getStatus: async () => 'unknown',
      stop: async () => {
        events.push('stop');
      },
      markChecked: async (status) => {
        events.push(`check:${status}`);
      },
      markStopped: async () => {
        events.push('record-stop');
      },
      markRemoved: async () => {
        events.push('preserve-unavailable');
      },
    });

    expect(result).toBe('checked');
    expect(events).toEqual(['check:unknown']);
  });

  // A provider round-trip that throws must never be read as proof of removal:
  // `getStatus` rejecting degrades to `unknown`, which is explicitly
  // non-terminal. Preserving on a network blip would strand a healthy session.
  test('a throwing provider status is not treated as removal', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => true,
      getStatus: async () => {
        throw new Error('ECONNRESET');
      },
      stop: async () => {
        events.push('stop');
      },
      markChecked: async (status) => {
        events.push(`check:${status}`);
      },
      markStopped: async () => {
        events.push('record-stop');
      },
      markRemoved: async () => {
        events.push('preserve-unavailable');
      },
    });

    expect(result).toBe('checked');
    expect(events).toEqual(['check:unknown']);
  });

  test('does not inspect or stop the provider after losing the cleanup claim', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => false,
      getStatus: async () => {
        events.push('status');
        return 'running';
      },
      stop: async () => {
        events.push('stop');
      },
      markChecked: async () => {
        events.push('check');
      },
      markStopped: async () => {
        events.push('record-stop');
      },
      markRemoved: async () => {
        events.push('preserve-unavailable');
      },
    });

    expect(result).toBe('skipped');
    expect(events).toEqual([]);
  });
});
