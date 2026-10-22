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

  // A status that is neither running nor removed proves nothing: it is
  // recorded, and the box is neither stopped nor preserved as gone.
  test.each(['stopped', 'unknown'])(
    'a `%s` status is only recorded, never stopped or preserved as gone',
    async (status) => {
      const events: string[] = [];
      const result = await reconcileRuntimeWakeCandidate({
        claim: async () => {
          events.push('claim');
          return true;
        },
        getStatus: async () => status,
        stop: async () => {
          events.push('stop');
        },
        markChecked: async (checked) => {
          events.push(`check:${checked}`);
        },
        markStopped: async () => {
          events.push('record-stop');
        },
        markRemoved: async () => {
          events.push('preserve-unavailable');
        },
      });

      expect(result).toBe('checked');
      expect(events).toEqual(['claim', `check:${status}`]);
    },
  );

  // Regression for a prod session (2026-08-13). Its Platinum box was
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

  // A `removed` answer alone has condemned LIVE boxes in prod (2026-10-02/03):
  // Platinum reported `removed` for two parked runtimes — a transient
  // failed-start during their own start retry — and their boxes served traffic
  // minutes later. The `/start` open phase and the parked sweep both ask the
  // in-place recovery gate before writing a loss; this pass must too. Either
  // non-preserve gate outcome — the gate accepted a recovery, or another
  // writer already owns one — leaves the row to the recovery flow, never to a
  // gravestone.
  test.each(['recovered', 'recovery-in-flight'] as const)(
    'a removed box the recovery gate does not condemn (%s) is not preserved as lost',
    async (outcome) => {
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
        recoverRemoved: async () => {
          events.push('recover');
          return outcome;
        },
      });

      expect(result).toBe('recovering');
      expect(events).toEqual(['claim', 'recover', 'check:removed']);
    },
  );

  // The gate refines the verdict; it does not retire it. A `removed` the
  // recovery gate answers `unavailable` for (or a provider without a recovery
  // gate at all) is still the 2026-08-13 case: this pass is the only component
  // that asks the provider about a parked row, so its preserve must stand.
  test('a removed box the recovery gate cannot save is still preserved', async () => {
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
      recoverRemoved: async () => {
        events.push('recover');
        return 'preserve-lost';
      },
    });

    expect(result).toBe('removed');
    expect(events).toEqual(['claim', 'recover', 'preserve-unavailable']);
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
