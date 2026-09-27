import { describe, expect, test } from 'bun:test';
import { MIDTURN_STOP_CONFIRMATION_MS } from '../reaping/sandbox-state-sync';
import { runStoppedObservationFollowUp } from './stopped-observation-followup';

const noSleep = async () => {};

// Every case uses its own sandbox id: the in-flight set is keyed by it and a
// follow-up releases its key when it settles.

describe('runStoppedObservationFollowUp', () => {
  test('THE INCIDENT: a silently-failed resume reconciles the row within the bound', async () => {
    // 2026-08-26, a prod session on E2B: `/start` answered 202, the resume
    // never produced a running box, and the rows read `running` for 5+ minutes
    // while the provider reported "sandbox … is not running (status: stopped)".
    let delayed = -1;
    let reconciled = 0;
    const result = await runStoppedObservationFollowUp({
      externalId: 'ext-1',
      sandboxId: 'sbx-1',
      getStatus: async () => 'stopped',
      reconcile: async () => {
        reconciled += 1;
        return true;
      },
      sleep: async (ms) => {
        delayed = ms;
      },
    });
    expect(result).toBe('reconciled');
    expect(reconciled).toBe(1);
    // The re-read waits out the confirmation window, or the reconcile it feeds
    // is still inside the window and cannot park. It stays bounded.
    expect(delayed).toBeGreaterThan(MIDTURN_STOP_CONFIRMATION_MS);
    expect(delayed).toBeLessThanOrEqual(61_000);
  });

  test('re-reads the provider and NEVER acts on the stale observation', async () => {
    let reconciled = 0;
    const result = await runStoppedObservationFollowUp({
      externalId: 'ext-2',
      sandboxId: 'sbx-2',
      getStatus: async () => 'running',
      reconcile: async () => {
        reconciled += 1;
        return true;
      },
      sleep: noSleep,
    });
    expect(result).toBe('provider-running');
    expect(reconciled).toBe(0);
  });

  test('a throwing provider read degrades to unknown, which never confirms a park', async () => {
    let reconciled = 0;
    const result = await runStoppedObservationFollowUp({
      externalId: 'ext-3',
      sandboxId: 'sbx-3',
      getStatus: async () => {
        throw new Error('ECONNRESET');
      },
      reconcile: async () => {
        reconciled += 1;
        return true;
      },
      sleep: noSleep,
    });
    expect(result).toBe('provider-running');
    expect(reconciled).toBe(0);
  });

  test('a 1/s /start poll schedules exactly one follow-up per sandbox', async () => {
    let reconciled = 0;
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const run = () =>
      runStoppedObservationFollowUp({
        externalId: 'ext-4',
        sandboxId: 'sbx-4',
        getStatus: async () => 'stopped',
        reconcile: async () => {
          reconciled += 1;
          return true;
        },
        sleep: () => gate,
      });
    const first = run();
    const duplicates = await Promise.all([run(), run(), run()]);
    expect(duplicates).toEqual(['duplicate', 'duplicate', 'duplicate']);
    released();
    expect(await first).toBe('reconciled');
    expect(reconciled).toBe(1);
    // The set is released, so a LATER observation may schedule again.
    expect(
      await runStoppedObservationFollowUp({
        externalId: 'ext-4',
        sandboxId: 'sbx-4',
        getStatus: async () => 'running',
        reconcile: async () => true,
        sleep: noSleep,
      }),
    ).toBe('provider-running');
  });

  test('a deferred park that the reconcile still refuses is reported, not forced', async () => {
    // `reconcile` returning false is the mid-turn confirmation gate (or the
    // wake fence) still holding. The follow-up reports it and stops — it has no
    // path that writes a stop of its own.
    const result = await runStoppedObservationFollowUp({
      externalId: 'ext-5',
      sandboxId: 'sbx-5',
      getStatus: async () => 'stopped',
      reconcile: async () => false,
      sleep: noSleep,
    });
    expect(result).toBe('still-open');
  });
});
