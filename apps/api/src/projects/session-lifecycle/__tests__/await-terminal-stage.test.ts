import { describe, test, expect } from 'bun:test';
import { awaitTerminalStage } from '../await-stage';
import type { SessionStartResult } from '../../routes/shared';

const mk = (stage: string, retriable: boolean | null = true): SessionStartResult =>
  ({ stage, retriable }) as unknown as SessionStartResult;

const noSleep = async () => {};
// Deterministic clock: each call advances by `step` (no wall-clock in the test).
const stepNow = (step: number) => {
  let t = -step;
  return () => {
    t += step;
    return t;
  };
};

describe('awaitTerminalStage — session-start long-poll loop', () => {
  test('returns immediately when already ready (no resolve)', async () => {
    let calls = 0;
    const r = await awaitTerminalStage(
      mk('ready', false),
      async () => {
        calls++;
        return mk('ready', false);
      },
      { waitMs: 6000, now: stepNow(200), sleepFn: noSleep },
    );
    expect(r.stage).toBe('ready');
    expect(calls).toBe(0);
  });

  test('returns immediately when waitMs<=0 (one-shot, unchanged behavior)', async () => {
    let calls = 0;
    const r = await awaitTerminalStage(
      mk('provisioning'),
      async () => {
        calls++;
        return mk('ready', false);
      },
      { waitMs: 0, now: stepNow(200), sleepFn: noSleep },
    );
    expect(r.stage).toBe('provisioning');
    expect(calls).toBe(0);
  });

  test('resolves the instant it flips ready — not at the deadline', async () => {
    let n = 0;
    const r = await awaitTerminalStage(
      mk('provisioning'),
      async () => {
        n++;
        return n >= 3 ? mk('ready', false) : mk('starting');
      },
      { waitMs: 6000, pollMs: 200, now: stepNow(200), sleepFn: noSleep },
    );
    expect(r.stage).toBe('ready');
    expect(n).toBe(3); // broke early, didn't run to the ~30-tick deadline
  });

  test('returns the latest non-ready payload at the deadline', async () => {
    let n = 0;
    const r = await awaitTerminalStage(
      mk('provisioning'),
      async () => {
        n++;
        return mk('starting');
      },
      { waitMs: 1000, pollMs: 200, now: stepNow(200), sleepFn: noSleep },
    );
    expect(r.stage).toBe('starting');
    expect(n).toBeLessThanOrEqual(5); // ~1000/200 ticks, bounded by the deadline
  });

  test('stops on a terminal failed stage', async () => {
    let n = 0;
    const r = await awaitTerminalStage(
      mk('provisioning'),
      async () => {
        n++;
        return mk('failed', false);
      },
      { waitMs: 6000, now: stepNow(200), sleepFn: noSleep },
    );
    expect(r.stage).toBe('failed');
    expect(n).toBe(1);
  });

  test('stops if the session vanishes mid-wait (resolve → null)', async () => {
    const r = await awaitTerminalStage(
      mk('provisioning'),
      async () => null,
      { waitMs: 6000, now: stepNow(200), sleepFn: noSleep },
    );
    expect(r.stage).toBe('provisioning'); // keeps the last good payload
  });
});
