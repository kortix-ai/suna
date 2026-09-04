import { describe, expect, test } from 'bun:test';
import { deliverWithRetry, type DeliveryTarget } from '../deliver';

// Regression guard for "@Kortix replied 'Still waking this thread's session back
// up — send that again' on a session that was already awake." The runtime was
// ready; the prompt hand-off just had a transient post-wake hiccup (a rotated
// opencode session 404, a daemon 5xx, a briefly-null externalId). The old path
// bounced to 'pending' on the first miss and dropped the message. deliverWithRetry
// must heal + retry through that window and only surface 'pending' if it truly
// never lands.

const ready = (externalId: string | null, opencodeSessionId: string | null): DeliveryTarget => ({
  stage: 'ready',
  externalId,
  opencodeSessionId,
});

const noSleep = async () => {};
// Deterministic clock: each call advances by `step` (no wall-clock in the test).
const stepNow = (step: number) => {
  let t = -step;
  return () => {
    t += step;
    return t;
  };
};

describe('deliverWithRetry — hand the prompt off through the post-wake flake', () => {
  test('happy path: first send accepted → delivered, never reopens', async () => {
    let sends = 0;
    let reopens = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => {
        reopens++;
        return ready('ext-1', 'oc-1');
      },
      send: async () => {
        sends++;
        return true;
      },
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
    expect(sends).toBe(1);
    expect(reopens).toBe(0);
  });

  test('THE FIX: a transient send failure is healed + retried → delivered (not pending)', async () => {
    let sends = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-2'), // rotated opencode session
      send: async (_ext, oc) => {
        sends++;
        return oc === 'oc-2'; // first id 404s, healed id is accepted
      },
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
    expect(sends).toBe(2);
  });

  test('externalId briefly null at ready → waits for the resume to surface it, then delivers', async () => {
    const outcome = await deliverWithRetry({
      opened: ready(null, 'oc-1'), // mid-resume: no external id yet → cannot send
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => true,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('delivered');
  });

  test('send never succeeds before the deadline → pending (the honest last resort)', async () => {
    let sends = 0;
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ready('ext-1', 'oc-1'),
      send: async () => {
        sends++;
        return false;
      },
      now: stepNow(10_000),
      sleepFn: noSleep,
      deadlineMs: 45_000,
    });
    expect(outcome).toBe('pending');
    expect(sends).toBeGreaterThan(1); // it really did retry, not bounce on the first miss
  });

  test('reopen finds the session gone → no-session', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => null,
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('no-session');
  });

  // A DOWN RUNTIME IS NOT A FAILED DELIVERY. This loop stops re-trying a dead
  // box in-line — that part was always right — but the outcome it reports has
  // to say WHY, because the drain turns 'failed' into a dead-letter on the
  // first attempt. Essentia 2026-08-26: a queued prompt delivered while the box
  // was unreachable went `state:failed, attempts:1` and was never re-tried when
  // the box came back minutes later.
  test('reopen reports a parked runtime → unreachable (stop retrying HERE, keep the prompt)', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ({ stage: 'failed', externalId: null, opencodeSessionId: null }),
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('unreachable');
  });

  test('reopen reports a hibernated box → unreachable, not failed', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => ({ stage: 'stopped', externalId: null, opencodeSessionId: null }),
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('unreachable');
  });

  test('a MISSING session stays terminal — there is nothing to come back to', async () => {
    const outcome = await deliverWithRetry({
      opened: ready('ext-1', 'oc-1'),
      reopen: async () => null,
      send: async () => false,
      now: stepNow(1000),
      sleepFn: noSleep,
    });
    expect(outcome).toBe('no-session');
  });
});
